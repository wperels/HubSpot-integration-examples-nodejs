require('dotenv').config();

const path = require('path');
const express = require('express');
const hubspot = require('@hubspot/api-client');

if (!process.env.HUBSPOT_SERVICE_KEY) {
  throw new Error('HUBSPOT_SERVICE_KEY is missing. Add it to your .env file.');
}

const app = express();
const client = new hubspot.Client({ accessToken: process.env.HUBSPOT_SERVICE_KEY });
const PORT = process.env.PORT || 3001;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function titleCase(value = '') {
  return value
    .trim()
    .toLowerCase()
    .replace(/(^|[\s'-])([a-z])/g, (_, prefix, letter) => `${prefix}${letter.toUpperCase()}`);
}

function cleanPhone(value = '') {
  const digits = value.replace(/\D/g, '');
  if (digits.length === 10) {
    return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return value.trim();
}

function cleanContact(record) {
  return {
    firstname: titleCase(record.firstname),
    lastname: titleCase(record.lastname),
    email: (record.email || '').trim().toLowerCase(),
    phone: cleanPhone(record.phone),
  };
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

async function findExistingContacts(contact) {
  const filterGroups = [
    { filters: [{ propertyName: 'email', operator: 'EQ', value: contact.email }] },
    { filters: [{ propertyName: 'hs_additional_emails', operator: 'EQ', value: contact.email }] },
  ];

  if (contact.firstname && contact.lastname) {
    filterGroups.push({
      filters: [
        { propertyName: 'firstname', operator: 'EQ', value: contact.firstname },
        { propertyName: 'lastname', operator: 'EQ', value: contact.lastname },
      ],
    });
  }

  const response = await client.crm.contacts.searchApi.doSearch({
    filterGroups,
    properties: ['email', 'hs_additional_emails', 'firstname', 'lastname', 'phone'],
    limit: 10,
    after: 0,
    sorts: [],
  });

  return response.results;
}

function digitsOnly(value = '') {
  return String(value).replace(/\D/g, '');
}

function classifyMatch(contact, results) {
  const byEmail = results.find(
    (r) => (r.properties.email || '').toLowerCase() === contact.email
  );
  if (byEmail) return { type: 'email', record: byEmail };

  const bySecondaryEmail = results.find((r) =>
    (r.properties.hs_additional_emails || '')
      .split(';')
      .map((e) => e.trim().toLowerCase())
      .includes(contact.email)
  );
  if (bySecondaryEmail) return { type: 'secondary email', record: bySecondaryEmail };

  const phone = digitsOnly(contact.phone);
  const byNamePhone = phone && results.find(
    (r) => digitsOnly(r.properties.phone) === phone
  );
  if (byNamePhone) return { type: 'name+phone', record: byNamePhone };

  if (results.length) return { type: 'name', record: results[0] };
  return null;
}

function parseConflict(error) {
  const status = error.code ?? error.statusCode ?? error.response?.status;
  if (status !== 409) return null;
  const body = typeof error.body === 'string' ? error.body : JSON.stringify(error.body || {});
  const match = body.match(/Existing ID:\s*(\d+)/i);
  return { id: match ? match[1] : null };
}

app.post('/api/check', async (req, res) => {
  const records = Array.isArray(req.body.records) ? req.body.records : [];
  const seenEmails = new Set();
  const results = [];

  for (let index = 0; index < records.length; index += 1) {
    const original = records[index];
    const contact = cleanContact(original);
    const name = `${contact.firstname} ${contact.lastname}`.trim() || 'Unnamed contact';

    const result = {
      row: index + 1,
      original,
      cleaned: contact,
      name,
      status: '',
      message: '',
      hubspotId: null,
    };

    if (!contact.email) {
      result.status = 'needs-correction';
      result.message = 'Missing email address.';
    } else if (!validEmail(contact.email)) {
      result.status = 'needs-correction';
      result.message = 'Email format is not valid.';
    } else if (seenEmails.has(contact.email)) {
      result.status = 'duplicate-upload';
      result.message = 'Duplicate email within this upload.';
    } else {
      seenEmails.add(contact.email);

      try {
        const found = await findExistingContacts(contact);
        const match = classifyMatch(contact, found);

        if (match && (match.type === 'email' || match.type === 'secondary email')) {
          result.status = 'already-exists';
          result.message =
            match.type === 'email'
              ? 'A contact with this email already exists in HubSpot.'
              : 'This email is a secondary email on an existing HubSpot contact.';
          result.hubspotId = match.record.id;
        } else if (match) {
          result.status = 'possible-duplicate';
          result.message = `Possible duplicate (matched on ${match.type}).`;
          result.hubspotId = match.record.id;
        } else {
          result.status = 'ready';
          result.message = 'Clean, valid, and not found in HubSpot.';
        }
      } catch (error) {
        console.error(`HubSpot search error for ${contact.email}:`, error.body || error.message);
        result.status = 'check-error';
        result.message = 'Could not check HubSpot. No record will be created.';
      }
    }

    results.push(result);
  }

  const summary = results.reduce(
    (counts, result) => {
      counts[result.status] = (counts[result.status] || 0) + 1;
      return counts;
    },
    {}
  );

  res.json({ results, summary });
});

app.post('/api/create', async (req, res) => {
  const contacts = Array.isArray(req.body.contacts) ? req.body.contacts : [];
  const created = [];
  const existing = [];
  const errors = [];

  for (const contact of contacts) {
    try {
      const createdContact = await client.crm.contacts.basicApi.create({
        properties: {
          firstname: contact.firstname,
          lastname: contact.lastname,
          email: contact.email,
          phone: contact.phone,
        },
      });

      created.push({
        email: contact.email,
        id: createdContact.id,
      });
    } catch (error) {
      const conflict = parseConflict(error);
      if (conflict) {
        existing.push({ email: contact.email, id: conflict.id });
        continue;
      }

      console.error(`HubSpot create error for ${contact.email}:`, error.body || error.message);
      errors.push({
        email: contact.email,
        message: error.body?.message || error.message,
      });
    }
  }

  res.json({ created, existing, errors });
});

app.listen(PORT, () => {
  console.log(`Contact Quality Gatekeeper running at http://localhost:${PORT}`);
});