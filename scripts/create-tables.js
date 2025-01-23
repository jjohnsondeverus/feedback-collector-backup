// create-tables.js
const { DynamoDBClient, CreateTableCommand } = require('@aws-sdk/client-dynamodb');
const { TableSchema } = require('../services/db-schema');

// Configure AWS SDK for local development
const configureAWS = () => {
  return new DynamoDBClient({
    region: process.env.AWS_REGION || 'us-west-2',
    endpoint: process.env.DYNAMODB_ENDPOINT || 'http://localhost:8000',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'local',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'local'
    }
  });
};

const createTable = async () => {
  const dynamodb = configureAWS();

  try {
    const result = await dynamodb.send(new CreateTableCommand(TableSchema));
    console.log('Table created successfully:', result);
    return result;
  } catch (error) {
    if (error.name === 'ResourceInUseException') {
      console.log('Table already exists');
    } else {
      console.error('Error creating table:', error);
      throw error;
    }
  }
};

// Run if called directly
if (require.main === module) {
  createTable()
    .then(() => console.log('Setup complete'))
    .catch(err => console.error('Setup failed:', err));
}

module.exports = { createTable };