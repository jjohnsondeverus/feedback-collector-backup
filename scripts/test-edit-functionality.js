const FeedbackCollectionService = require('../services/feedback-service');

const testEditFunctionality = async () => {
  const service = new FeedbackCollectionService();

  try {
    console.log('1. Creating initial session and feedback...');
    const session = await service.startSession({
      userId: 'test_user',
      channels: ['C123456'],
      startDate: '2024-01-01',
      endDate: '2024-01-07'
    });

    await service.addFeedbackItems({
      sessionId: session.sessionId,
      channelId: 'C123456',
      items: [{
        title: 'Original Feedback',
        description: 'Initial description',
        priority: 'MEDIUM',
        type: 'BUG'
      }]
    });

    console.log('\n2. Testing feedback item update...');
    const updateResult = await service.updateFeedbackItem({
      sessionId: session.sessionId,
      channelId: 'C123456',
      itemIndex: 0,
      updates: {
        title: 'Updated Feedback',
        priority: 'HIGH'
      },
      userId: 'test_user'
    });
    console.log('Update result:', updateResult);

    console.log('\n3. Verifying updates...');
    const updatedSession = await service.getSessionWithItems(session.sessionId);
    console.log('Updated feedback:', JSON.stringify(updatedSession.itemsByChannel['C123456'][0], null, 2));

    console.log('\n✅ Edit functionality tests passed!');
  } catch (error) {
    console.error('\n❌ Test failed:', error);
  }
};

if (require.main === module) {
  testEditFunctionality();
} 