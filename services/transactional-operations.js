const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { 
  DynamoDBDocumentClient, 
  PutCommand, 
  UpdateCommand,
  GetCommand,
  TransactWriteCommand
} = require('@aws-sdk/lib-dynamodb');
const { v4: uuidv4 } = require('uuid');

class TransactionalOperations {
  constructor() {
    const client = new DynamoDBClient({
      region: process.env.AWS_REGION || 'us-west-2',
      endpoint: process.env.DYNAMODB_ENDPOINT || 'http://localhost:8000',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'local',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'local'
      }
    });

    this.dynamodb = DynamoDBDocumentClient.from(client);
    this.tableName = 'FeedbackCollector';
  }

  // Helper to create a unique transaction ID
  generateTransactionId() {
    return `txn_${Date.now()}_${uuidv4()}`;
  }

  // Transactional update of feedback item with history
  async updateFeedbackItemTransaction({
    sessionId,
    channelId,
    itemIndex,
    updates,
    userId
  }) {
    const timestamp = new Date().toISOString();
    const transactionId = `EDIT#${uuidv4()}`;

    try {
      // Create the update expression and attribute values
      const { updateExpression, expressionAttributeValues, expressionAttributeNames } = 
        this.buildUpdateExpression(updates);

      const command = new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: this.tableName,
              Key: {
                PK: `SESSION#${sessionId}`,
                SK: `FEEDBACK#${channelId}#${itemIndex}`
              },
              UpdateExpression: updateExpression,
              ExpressionAttributeValues: {
                ...expressionAttributeValues,
                ':timestamp': timestamp,
                ':transactionId': transactionId
              },
              ExpressionAttributeNames: expressionAttributeNames,
              ConditionExpression: 'attribute_exists(PK)'
            }
          }
        ]
      });

      await this.dynamodb.send(command);
      return { transactionId, timestamp };
    } catch (error) {
      console.error('Error in updateFeedbackItemTransaction:', error);
      throw error;
    }
  }

  // Transactional duplicate detection and caching
  async recordDuplicateTransaction({
    sessionId,
    itemId,
    jiraTicketKey,
    similarityScore,
    matchType,
    userId
  }) {
    const transactionId = this.generateTransactionId();
    const timestamp = new Date().toISOString();

    try {
      await this.dynamodb.send(new PutCommand({
        TableName: this.tableName,
        Item: {
          PK: `SESSION#${sessionId}`,
          SK: `DUPLICATE#${itemId}`,
          jiraTicketKey,
          similarityScore,
          matchType,
          recordedBy: userId,
          recordedAt: timestamp,
          transactionId
        }
      }));

      return { transactionId, timestamp };
    } catch (error) {
      console.error('Transaction failed:', error);
      throw error;
    }
  }

  // Transactional ticket creation
  async createJiraTicketTransaction({
    sessionId,
    itemId,
    jiraTicketKey,
    jiraTicketUrl,
    userId
  }) {
    const transactionId = this.generateTransactionId();
    const timestamp = new Date().toISOString();

    try {
      await this.dynamodb.send(new PutCommand({
        TableName: this.tableName,
        Item: {
          PK: `SESSION#${sessionId}`,
          SK: `JIRA#${itemId}`,
          jiraTicketKey,
          jiraTicketUrl,
          createdBy: userId,
          createdAt: timestamp,
          transactionId
        }
      }));

      return { transactionId, timestamp };
    } catch (error) {
      console.error('Transaction failed:', error);
      throw error;
    }
  }

  // Helper methods for building DynamoDB expressions
  buildUpdateExpression(updates) {
    const expressionParts = [];
    const expressionAttributeValues = {};
    const expressionAttributeNames = {};
    
    Object.entries(updates).forEach(([key, value]) => {
      expressionParts.push(`#${key} = :${key}`);
      expressionAttributeValues[`:${key}`] = value;
      expressionAttributeNames[`#${key}`] = key;
    });

    // Add metadata updates
    expressionParts.push('#lastModified = :timestamp');
    expressionParts.push('#lastTransactionId = :transactionId');
    expressionAttributeNames['#lastModified'] = 'lastModified';
    expressionAttributeNames['#lastTransactionId'] = 'lastTransactionId';

    return {
      updateExpression: `SET ${expressionParts.join(', ')}`,
      expressionAttributeValues,
      expressionAttributeNames
    };
  }

  async updateChannelConfigTransaction({ sessionId, channelId, updates }) {
    const timestamp = new Date().toISOString();
    const transactionId = `CONFIG#${uuidv4()}`;

    try {
      const command = new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: this.tableName,
              Key: {
                PK: `SESSION#${sessionId}`,
                SK: `CONFIG#${channelId}`
              },
              UpdateExpression: 'SET #projectKey = :projectKey, #lastModified = :timestamp, #lastTransactionId = :transactionId',
              ExpressionAttributeNames: {
                '#projectKey': 'projectKey',
                '#lastModified': 'lastModified',
                '#lastTransactionId': 'lastTransactionId'
              },
              ExpressionAttributeValues: {
                ':projectKey': updates.projectKey,
                ':timestamp': timestamp,
                ':transactionId': transactionId
              },
              ConditionExpression: 'attribute_exists(PK)'
            }
          }
        ]
      });

      await this.dynamodb.send(command);
      return { transactionId, timestamp };
    } catch (error) {
      console.error('Error in updateChannelConfigTransaction:', error);
      throw error;
    }
  }
}

module.exports = TransactionalOperations;