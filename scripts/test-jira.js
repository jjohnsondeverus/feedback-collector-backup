require('dotenv').config();
const FeedbackCollectionService = require('../services/feedback-service');
const MockJiraService = require('../services/mock-jira-service');
const MockSlackClient = require('../services/mock-slack-client');

const testJiraCreation = async () => {
  const slackClient = new MockSlackClient();
  const jiraService = new MockJiraService();
  const service = new FeedbackCollectionService(jiraService, { slackClient });

  try {
    console.log('1. Creating test session...');
    const session = await service.startSession({
      userId: 'test_user',
      channels: ['C123456'],
      startDate: '2024-01-01',
      endDate: '2024-01-07'
    });

    console.log('\n2. Setting project key...');
    await service.setProjectKey({
      sessionId: session.sessionId,
      channelId: 'C123456',
      projectKey: 'PROJ-123',
      userId: 'test_user'
    });

    console.log('\n3. Adding test feedback items...');
    const feedbackItems = [
      {
        title: 'Search Performance Issue',
        description: 'Search is slow with large result sets',
        type: 'BUG',
        priority: 'HIGH',
        user_impact: 'Users experiencing delays',
        current_behavior: 'Search takes 10+ seconds',
        expected_behavior: 'Search should complete in < 2 seconds'
      }
    ];

    await service.addFeedbackItems({
      sessionId: session.sessionId,
      channelId: 'C123456',
      items: feedbackItems
    });

    console.log('\n4. Creating Jira tickets...');
    const results = await service.createJiraTickets({
      sessionId: session.sessionId,
      channelId: 'C123456',
      userId: 'test_user'
    });

    console.log('Jira tickets created:', results);

    console.log('\n✅ All Jira tests passed!');
  } catch (error) {
    console.error('\n❌ Test failed:', error);
  }
};

if (require.main === module) {
  testJiraCreation();
} 