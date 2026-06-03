require('dotenv').config();

const { Client } = require('pg');

const client = new Client({
  host: 'turntable.proxy.rlwy.net',
  port: 14549,
  user: 'postgres',
  password: 'orJnlTOcxrMpajqMQQHZWvSKptbuwAjX',
  database: 'railway',
  ssl: {
    rejectUnauthorized: false,
  },
});

client.connect()
  .then(() => {
    console.log('Connected!');
    return client.end();
  })
  .catch(err => {
    console.error(err);
  });