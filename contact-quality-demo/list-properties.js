// in bash run
//node list-properties.js companies
//node list-properties.js contacts

require('dotenv').config();
const fs = require('fs');

const object = process.argv[2] || 'contacts';
const csvCell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;

(async () => {
  const res = await fetch(`https://api.hubapi.com/crm/v3/properties/${object}`, {
    headers: { Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}` },
  });
  const data = await res.json();

  if (!data.results) {
    console.log(res.status, data.message);
    return;
  }

  const header = ['internal_name', 'label', 'type', 'field_type', 'group', 'read_only', 'custom'];
  const rows = data.results
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => [
      p.name,
      p.label,
      p.type,
      p.fieldType,
      p.groupName,
      p.modificationMetadata?.readOnlyValue ? 'yes' : 'no',
      p.hubspotDefined ? 'no' : 'yes',
    ]);

  const csv = [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n');
  const file = `${object}-properties.csv`;
  fs.writeFileSync(file, csv);
  console.log(`Saved ${rows.length} properties to ${file}`);
})();