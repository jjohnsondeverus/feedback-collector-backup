require('dotenv').config();
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { createTable } = require('./create-tables');
const dynamoDBService = require('../services/dynamodb-service');

const testInfrastructure = async () => {
  try {
    console.log('1. Creating table...');
    await createTable();

    console.log('\n2. Testing session creation...');
    const sessionId = await dynamoDBService.createSession(
      'test_user_1',
      ['C123456', 'C789012'],
      '2024-01-01',
      '2024-01-07'
    );
    console.log('Session created with ID:', sessionId);

    console.log('\n3. Testing session retrieval...');
    const session = await dynamoDBService.getSession(sessionId);
    console.log('Retrieved session:', JSON.stringify(session, null, 2));

    console.log('\n4. Testing feedback item creation...');
    const testFeedbackItems = [
      {
        title: 'Test Feedback 1',
        description: 'This is a test feedback item',
        priority: 'HIGH',
        type: 'BUG'
      },
      {
        title: 'Test Feedback 2',
        description: 'Another test feedback item',
        priority: 'MEDIUM',
        type: 'FEATURE'
      }
    ];

    await dynamoDBService.addFeedbackItems(sessionId, 'C123456', testFeedbackItems);
    console.log('Feedback items added');

    console.log('\n5. Testing feedback items retrieval...');
    const feedbackItems = await dynamoDBService.getFeedbackItems(sessionId);
    console.log('Retrieved feedback items:', JSON.stringify(feedbackItems, null, 2));

    console.log('\n✅ All tests passed!');
  } catch (error) {
    console.error('\n❌ Test failed:', error);
  }
};

// Run if called directly
if (require.main === module) {
  testInfrastructure();
}