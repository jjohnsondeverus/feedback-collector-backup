const FeedbackCollectionService = require('../services/feedback-service');
const MockSlackClient = require('../services/mock-slack-client');
const dynamoDBService = require('../services/dynamodb-service');

const testErrorHandling = async () => {
  const slackClient = new MockSlackClient();
  const service = new FeedbackCollectionService(null, { slackClient });

  try {
    console.log('1. Testing invalid session ID handling...');
    try {
      await service.getSessionWithItems('invalid-session-id');
      console.error('❌ Should have thrown an error for invalid session');
    } catch (error) {
      console.log('✅ Properly handled invalid session:', error.message);
    }

    console.log('\n2. Testing invalid channel ID handling...');
    try {
      await service.getChannelMessages({
        channelId: 'INVALID',
        startDate: '2024-01-01',
        endDate: '2024-01-07'
      });
      console.error('❌ Should have thrown an error for invalid channel');
    } catch (error) {
      console.log('✅ Properly handled invalid channel:', error.message);
    }

    console.log('\n3. Testing invalid date range handling...');
    try {
      await service.startSession({
        userId: 'test_user',
        channels: ['C123456'],
        startDate: '2024-01-07',
        endDate: '2024-01-01' // End date before start date
      });
      console.error('❌ Should have thrown an error for invalid date range');
    } catch (error) {
      console.log('✅ Properly handled invalid date range:', error.message);
    }

    console.log('\n4. Testing transaction failure handling...');
    try {
      await service.updateFeedbackItem({
        sessionId: 'nonexistent-session',
        channelId: 'C123456',
        itemIndex: 999,
        updates: {
          title: 'Updated Title'
        },
        userId: 'test_user'
      });
      throw new Error('Should not reach this point');
    } catch (error) {
      if (error.message === 'Should not reach this point') {
        console.error('❌ Failed to catch transaction error');
      } else {
        console.log('✅ Properly handled transaction failure:', error.message);
      }
    }

    console.log('\n✅ All error handling tests completed!');
  } catch (error) {
    console.error('\n❌ Test suite failed:', error);
  }
};

if (require.main === module) {
  testErrorHandling();
} 