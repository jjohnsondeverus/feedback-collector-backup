require('dotenv').config();
const FeedbackCollectionService = require('../services/feedback-service');
const MockSlackClient = require('../services/mock-slack-client');

const testFeedbackPreview = async () => {
  const slackClient = new MockSlackClient();
  const service = new FeedbackCollectionService(null, { slackClient });

  try {
    console.log('1. Creating test session with feedback...');
    const session = await service.startSession({
      userId: 'test_user',
      channels: ['C123456'],
      startDate: '2024-01-01',
      endDate: '2024-01-07'
    });

    const messages = [
      { text: 'The search is really slow', user: 'U1', ts: '1234567890.000000' },
      { text: 'We need PDF export', user: 'U2', ts: '1234567891.000000' }
    ];

    await service.collectFeedbackFromMessages({
      sessionId: session.sessionId,
      channelId: 'C123456',
      messages
    });

    console.log('\n2. Testing feedback preview...');
    const preview = await service.previewFeedbackItems({
      sessionId: session.sessionId,
      channelId: 'C123456'
    });
    console.log('Preview items:', JSON.stringify(preview, null, 2));

    console.log('\n3. Testing feedback item update...');
    const updateResult = await service.updateFeedbackItem({
      sessionId: session.sessionId,
      channelId: 'C123456',
      itemIndex: 0,
      updates: {
        title: 'Updated Title',
        priority: 'HIGH'
      },
      userId: 'test_user'
    });
    console.log('Update result:', updateResult);

    console.log('\n4. Testing item exclusion...');
    await service.excludeFeedbackItem({
      sessionId: session.sessionId,
      channelId: 'C123456',
      itemIndex: 1,
      userId: 'test_user'
    });

    const finalPreview = await service.previewFeedbackItems({
      sessionId: session.sessionId,
      channelId: 'C123456'
    });
    console.log('Final preview:', JSON.stringify(finalPreview, null, 2));

    console.log('\n✅ All preview tests passed!');
  } catch (error) {
    console.error('\n❌ Test failed:', error);
  }
};

if (require.main === module) {
  testFeedbackPreview();
} 