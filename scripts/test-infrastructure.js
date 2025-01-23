require('dotenv').config();
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { createTable } = require('./create-tables');
const dynamoDBService = require('../services/dynamodb-service');
const MockSlackClient = require('../services/mock-slack-client');
const FeedbackCollectionService = require('../services/feedback-service');

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

    console.log('\n🧪 Testing Channel Access...');
    await testChannelAccess();

    console.log('\n✅ All infrastructure tests passed!');
  } catch (error) {
    console.error('\n❌ Infrastructure test failed:', error);
    process.exit(1);
  }
};

async function testChannelAccess() {
  const slackClient = new MockSlackClient();
  const service = new FeedbackCollectionService(null, { slackClient });

  const testCases = [
    { 
      name: 'Public Channel', 
      channelId: 'C123456',
      expectSuccess: true
    },
    { 
      name: 'Private Channel', 
      channelId: 'C_PRIVATE',
      expectSuccess: true
    },
    { 
      name: 'No Access', 
      channelId: 'C_NO_ACCESS',
      expectSuccess: false,
      expectedError: 'Bot needs to be invited to this channel first'
    },
    { 
      name: 'Missing Permissions', 
      channelId: 'C_NO_PERMS',
      expectSuccess: false,
      expectedError: 'Bot lacks required permissions to join channels'
    },
    { 
      name: 'No Channel Info', 
      channelId: 'C_NO_INFO',
      expectSuccess: false,
      expectedError: 'Unable to get channel info: channel_not_found'
    }
  ];

  for (const test of testCases) {
    console.log(`\n  Testing ${test.name}...`);
    try {
      const messages = await service.getChannelMessages({
        channelId: test.channelId,
        startDate: '2024-01-01',
        endDate: '2024-01-07'
      });

      if (test.expectSuccess) {
        console.log('  ✅ Success:', messages.length, 'messages found');
      } else {
        console.log('  ❌ Failed: Expected error but got success');
        throw new Error('Expected error but got success');
      }
    } catch (error) {
      if (!test.expectSuccess && error.message === test.expectedError) {
        console.log('  ✅ Got expected error:', error.message);
      } else {
        console.log('  ❌ Unexpected error:', error.message);
        if (test.expectedError) {
          console.log('  Expected:', test.expectedError);
        }
        throw error;
      }
    }
  }
}

// Run if called directly
if (require.main === module) {
  testInfrastructure();
}