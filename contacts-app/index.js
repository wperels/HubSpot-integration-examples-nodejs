require('dotenv').config({path: '.env'});
require('csv-express');

const _ = require('lodash');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');

const PORT = 3000;
const CONTACTS_COUNT = 10;
const BASE_URL = 'https://api.hubapi.com';
const LIST_PROPS = ['firstname', 'lastname', 'company', 'email'];
const NOTE_TO_CONTACT = 202;

const hs = async (method, apiPath, body) => {
  const res = await fetch(`${BASE_URL}${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new Error(`HubSpot ${res.status} ${method} ${apiPath}: ${data.message || text}`);
  }
  return data;
};

const checkEnv = (req, res, next) => {
  if (_.startsWith(req.url, '/error')) return next();
  if (_.isNil(process.env.HUBSPOT_API_KEY)) {
    return res.redirect('/error?msg=Please set HUBSPOT_API_KEY env variable to proceed');
  }
  next();
};

const getFullName = (props) => {
  const first = _.get(props, 'firstname') || '';
  const last = _.get(props, 'lastname') || '';
  return `${first} ${last}`;
};

const prepareContactsContent = (contacts) =>
  _.map(contacts, (c) => ({
    vid: c.id,
    name: getFullName(c.properties),
    companyName: _.get(c, 'properties.company') || '',
  }));

const isReadOnly = (p) => _.get(p, 'modificationMetadata.readOnlyValue') || p.calculated;
const isMutable = (p) => _.get(p, 'modificationMetadata.readOnlyDefinition');

const getEditableProperties = (properties) =>
  _.reduce(properties, (acc, p) => {
    if (!isReadOnly(p)) acc[p.name] = {name: p.name, label: p.label};
    return acc;
  }, {});

const getMutableProperties = (properties) =>
  _.reduce(properties, (acc, p) => {
    if (!isMutable(p)) acc[p.name] = p;
    return acc;
  }, {});

const getContactEditableProperties = (contactProps, editable) =>
  _.reduce(editable, (acc, prop, name) => {
    acc[name] = {...prop};
    if (!_.isNil(contactProps[name])) acc[name].value = contactProps[name];
    return acc;
  }, {});

const getPropertyDetails = (p = {}) => ({
  name: {label: 'Name', value: p.name},
  label: {label: 'Label', value: p.label},
  description: {label: 'Description', value: p.description},
  groupName: {label: 'Group Name', value: p.groupName},
  type: {label: 'Type', value: p.type},
});

const FIELD_TYPES = {
  string: 'text', number: 'number', date: 'date',
  datetime: 'date', enumeration: 'select', bool: 'booleancheckbox',
};

const toCsv = (contacts, properties) =>
  _.map(contacts, (c) =>
    _.reduce(properties, (row, p) => {
      row[p.label] = _.get(c, ['properties', p.name]) || '';
      return row;
    }, {}));

const getAllProperties = async () => (await hs('GET', '/crm/v3/properties/contacts')).results;

const app = express();

app.use(express.static('css'));
app.use(express.static('html'));
app.use(bodyParser.urlencoded({limit: '50mb', extended: true}));
app.use(bodyParser.json({limit: '50mb', extended: true}));
app.use(express.static('public'));
app.set('view engine', 'pug');
app.set('views', path.join(__dirname, 'views'));
app.use(checkEnv);

app.get('/', (req, res) => res.redirect('/contacts'));

app.post('/contacts', async (req, res) => {
  try {
    const email = _.get(req, 'body.email');
    if (!_.isNil(email)) {
      const properties = _.pickBy(req.body, (v) => v !== '');
      console.log('Creating contact with email:', email);
      await hs('POST', '/crm/v3/objects/contacts', {properties});
    }
    res.redirect('/contacts');
  } catch (e) {
    console.error(e);
    res.redirect(`/error?msg=${encodeURIComponent(e.message)}`);
  }
});

app.post('/contacts/:vid', async (req, res) => {
  try {
    const vid = req.params.vid;
    console.log('Updating contact:', vid);
    await hs('PATCH', `/crm/v3/objects/contacts/${vid}`, {properties: req.body});
    res.redirect('/contacts');
  } catch (e) {
    console.error(e);
    res.redirect(`/error?msg=${encodeURIComponent(e.message)}`);
  }
});

app.get('/contacts', async (req, res) => {
  try {
    const search = _.get(req, 'query.search');
    let contacts;
    if (_.isNil(search)) {
      console.log('Retrieving contacts');
      const params = new URLSearchParams({limit: CONTACTS_COUNT, properties: LIST_PROPS.join(',')});
      contacts = (await hs('GET', `/crm/v3/objects/contacts?${params}`)).results;
    } else {
      console.log('Searching contacts:', search);
      contacts = (await hs('POST', '/crm/v3/objects/contacts/search', {
        query: search, limit: CONTACTS_COUNT, properties: LIST_PROPS,
      })).results;
    }
    res.render('contacts', {contacts: prepareContactsContent(contacts), search});
  } catch (e) {
    console.error(e);
    res.redirect(`/error?msg=${encodeURIComponent(e.message)}`);
  }
});

app.get('/contacts/new', async (req, res) => {
  try {
    const hubspotProperties = await getAllProperties();
    const owners = (await hs('GET', '/crm/v3/owners')).results;
    const properties = getContactEditableProperties({}, getEditableProperties(hubspotProperties));
    res.render('list', {items: properties, owners, action: '/contacts'});
  } catch (e) {
    console.error(e);
    res.redirect(`/error?msg=${encodeURIComponent(e.message)}`);
  }
});

app.get('/contacts/:vid', async (req, res) => {
  try {
    const vid = _.get(req, 'params.vid');
    if (_.isNil(vid)) return res.redirect('/error?msg=Missed contact');

    const hubspotProperties = await getAllProperties();
    const editableProperties = getEditableProperties(hubspotProperties);
    const propNames = _.keys(editableProperties).join(',');
    const contact = await hs('GET', `/crm/v3/objects/contacts/${vid}?properties=${encodeURIComponent(propNames)}`);
    const owners = (await hs('GET', '/crm/v3/owners')).results;

    const notes = (await hs('POST', '/crm/v3/objects/notes/search', {
      filterGroups: [{filters: [{propertyName: 'associations.contact', operator: 'EQ', value: vid}]}],
      properties: ['hs_note_body', 'hs_timestamp'],
      limit: 20,
    })).results;
    const engagements = _.map(notes, (n) => ({
      id: n.id, type: 'NOTE', title: _.get(n, 'properties.hs_note_body') || '',
    }));

    const properties = getContactEditableProperties(contact.properties, editableProperties);
    res.render('list', {
      items: properties, engagements, owners,
      action: `/contacts/${vid}`, engagementAction: `/contacts/${vid}/engagement`,
    });
  } catch (e) {
    console.error(e);
    res.redirect(`/error?msg=${encodeURIComponent(e.message)}`);
  }
});

app.get('/contacts/:vid/engagement', (req, res) => {
  const vid = _.get(req, 'params.vid');
  if (_.isNil(vid)) return res.redirect('/error?msg=Missed contact');
  res.render('engagements', {vid});
});

app.post('/contacts/:vid/engagement', async (req, res) => {
  try {
    const vid = req.params.vid;
    const title = _.get(req.body, 'metadata.title') || '';
    const body = _.get(req.body, 'metadata.body') || '';
    const noteBody = [title, body].filter(Boolean).join(' - ') || 'Note';
    await hs('POST', '/crm/v3/objects/notes', {
      properties: {hs_timestamp: new Date().toISOString(), hs_note_body: noteBody},
      associations: [{
        to: {id: vid},
        types: [{associationCategory: 'HUBSPOT_DEFINED', associationTypeId: NOTE_TO_CONTACT}],
      }],
    });
    res.redirect(`/contacts/${vid}`);
  } catch (e) {
    console.error(e);
    res.redirect(`/error?msg=${encodeURIComponent(e.message)}`);
  }
});

app.get('/properties', async (req, res) => {
  try {
    const properties = await getAllProperties();
    res.render('properties', {properties: getMutableProperties(properties)});
  } catch (e) {
    console.error(e);
    res.redirect(`/error?msg=${encodeURIComponent(e.message)}`);
  }
});

app.post('/properties', async (req, res) => {
  try {
    const body = {...req.body};
    body.fieldType = body.fieldType || FIELD_TYPES[body.type] || 'text';
    await hs('POST', '/crm/v3/properties/contacts', body);
    res.redirect('/properties');
  } catch (e) {
    console.error(e);
    res.redirect(`/error?msg=${encodeURIComponent(e.message)}`);
  }
});

app.post('/properties/:name', async (req, res) => {
  try {
    await hs('PATCH', `/crm/v3/properties/contacts/${req.params.name}`, req.body);
    res.redirect('/properties');
  } catch (e) {
    console.error(e);
    res.redirect(`/error?msg=${encodeURIComponent(e.message)}`);
  }
});

app.get('/properties/new', async (req, res) => {
  try {
    const groups = (await hs('GET', '/crm/v3/properties/contacts/groups')).results;
    res.render('list', {items: getPropertyDetails(), action: '/properties', groups});
  } catch (e) {
    console.error(e);
    res.redirect(`/error?msg=${encodeURIComponent(e.message)}`);
  }
});

app.get('/properties/:name', async (req, res) => {
  try {
    const name = _.get(req, 'params.name');
    if (_.isNil(name)) return res.redirect('/error?msg=Missed property');
    const hubspotProperties = await getAllProperties();
    const groups = (await hs('GET', '/crm/v3/properties/contacts/groups')).results;
    const property = _.find(hubspotProperties, {name});
    res.render('list', {items: getPropertyDetails(property), action: `/properties/${name}`, groups});
  } catch (e) {
    console.error(e);
    res.redirect(`/error?msg=${encodeURIComponent(e.message)}`);
  }
});

app.get('/export', async (req, res) => {
  try {
    const properties = _.reject(await getAllProperties(), 'hidden');
    const contacts = (await hs('POST', '/crm/v3/objects/contacts/search', {
      limit: CONTACTS_COUNT, properties: _.map(properties, 'name'),
    })).results;
    res.csv(toCsv(contacts, properties), true, {'Content-disposition': 'attachment; filename=contacts.csv'});
  } catch (e) {
    console.error(e);
    res.redirect(`/error?msg=${encodeURIComponent(e.message)}`);
  }
});

app.get('/error', (req, res) => res.render('error', {error: req.query.msg}));

app.use((error, req, res, next) => res.render('error', {error: error.message}));

app.listen(PORT, () => console.log(`Listening on http://localhost:${PORT}`));