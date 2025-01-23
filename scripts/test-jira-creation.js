process.env.JIRA_HOST = 'https://test-domain.atlassian.net';

const FeedbackCollectionService = require('../services/feedback-service');
const MockJiraClient = require('../services/mock-jira-client');
const dynamoDBService = require('../services/dynamodb-service');

const testJiraCreation = async () => {
  const jiraClient = new MockJiraClient();
  const service = new FeedbackCollectionService(jiraClient);

  try {
    console.log('1. Creating session with feedback...');
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
        title: 'Critical Login Bug',
        description: 'Users unable to login',
        priority: 'HIGH',
        type: 'BUG',
        user_impact: 'All users affected',
        current_behavior: 'Login button does nothing',
        expected_behavior: 'Users should be able to login'
      }]
    });

    console.log('\n2. Creating Jira ticket...');
    const ticketResult = await service.createJiraTicket({
      sessionId: session.sessionId,
      itemId: 'FEEDBACK#C123456#0',
      jiraTicketData: {
        fields: {
          project: { key: 'TEST' },
          summary: 'Critical Login Bug',
          description: 'Users unable to login',
          issuetype: { name: 'Bug' },
          priority: { name: 'High' }
        }
      },
      userId: 'test_user'
    });

    console.log('Ticket creation result:', JSON.stringify(ticketResult, null, 2));

    console.log('\n3. Verifying records in DynamoDB...');
    // Get session with feedback items
    const session2 = await service.getSessionWithItems(session.sessionId);
    console.log('Session with feedback:', JSON.stringify(session2, null, 2));

    // Get Jira ticket record
    const jiraRecords = await dynamoDBService.queryItems({
      PK: `SESSION#${session.sessionId}`,
      SKPrefix: 'JIRA#'
    });
    console.log('\nJira ticket records:', JSON.stringify(jiraRecords, null, 2));

    console.log('\n✅ Jira ticket creation tests passed!');
  } catch (error) {
    console.error('\n❌ Test failed:', error);
  }
};

if (require.main === module) {
  testJiraCreation();
} 