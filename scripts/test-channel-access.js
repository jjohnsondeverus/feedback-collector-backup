require('dotenv').config();
const FeedbackCollectionService = require('../services/feedback-service');
const MockSlackClient = require('../services/mock-slack-client');

const testChannelAccess = async () => {
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

  let allTestsPassed = true;

  for (const test of testCases) {
    console.log(`\nTesting ${test.name}...`);
    try {
      const messages = await service.getChannelMessages({
        channelId: test.channelId,
        startDate: '2024-01-01',
        endDate: '2024-01-07'
      });

      if (test.expectSuccess) {
        console.log('✅ Success:', messages.length, 'messages found');
      } else {
        console.log('❌ Failed: Expected error but got success');
        allTestsPassed = false;
      }
    } catch (error) {
      if (!test.expectSuccess && error.message === test.expectedError) {
        console.log('✅ Got expected error:', error.message);
      } else {
        console.log('❌ Unexpected error:', error.message);
        if (test.expectedError) {
          console.log('Expected:', test.expectedError);
        }
        allTestsPassed = false;
      }
    }
  }

  if (allTestsPassed) {
    console.log('\n✅ All channel access tests passed!');
  } else {
    console.log('\n❌ Some tests failed');
    process.exit(1);
  }
};

if (require.main === module) {
  testChannelAccess();
} 