const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { 
  DynamoDBDocumentClient, 
  PutCommand, 
  GetCommand, 
  QueryCommand, 
  TransactWriteCommand 
} = require('@aws-sdk/lib-dynamodb');
const { v4: uuidv4 } = require('uuid');

class DynamoDBService {
  constructor() {
    const client = new DynamoDBClient({
      region: process.env.AWS_REGION || 'us-west-2',
      endpoint: process.env.DYNAMODB_ENDPOINT || 'http://localhost:8000',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'local',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'local'
      }
    });

    this.dynamodb = DynamoDBDocumentClient.from(client, {
      marshallOptions: {
        removeUndefinedValues: true,
        convertEmptyValues: true
      }
    });
    this.tableName = 'FeedbackCollector';
  }

  // Create a new feedback session
  async createSession(userId, channels, startDate, endDate) {
    const sessionId = uuidv4();
    const timestamp = new Date().toISOString();

    try {
      // Create session metadata
      await this.dynamodb.send(new PutCommand({
        TableName: this.tableName,
        Item: {
          PK: `SESSION#${sessionId}`,
          SK: 'METADATA',
          userId,
          channels,
          startDate,
          endDate,
          createdAt: timestamp,
          status: 'ACTIVE'
        }
      }));

      // Initialize channel configs
      for (const channelId of channels) {
        await this.createChannelConfig(sessionId, channelId);
      }

      return sessionId;
    } catch (error) {
      console.error('Error creating session:', error);
      throw error;
    }
  }

  // Add feedback items to a session
  async addFeedbackItems(sessionId, channelId, items) {
    const operations = items.map((item, index) => ({
      Put: {
        TableName: this.tableName,
        Item: {
          PK: `SESSION#${sessionId}`,
          SK: `FEEDBACK#${channelId}#${index}`,
          GSI1PK: `CHANNEL#${channelId}`,
          GSI1SK: `SESSION#${sessionId}`,
          ...item,
          createdAt: new Date().toISOString()
        }
      }
    }));

    // Split into chunks of 25 due to DynamoDB transaction limits
    for (let i = 0; i < operations.length; i += 25) {
      const chunk = operations.slice(i, i + 25);
      await this.dynamodb.send(new TransactWriteCommand({
        TransactItems: chunk
      }));
    }
  }

  // Get session data
  async getSession(sessionId) {
    const result = await this.dynamodb.send(new GetCommand({
      TableName: this.tableName,
      Key: {
        PK: `SESSION#${sessionId}`,
        SK: 'METADATA'
      }
    }));

    return result.Item;
  }

  // Get feedback items for a session
  async getFeedbackItems(sessionId) {
    const result = await this.dynamodb.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: {
        ':pk': `SESSION#${sessionId}`,
        ':sk': 'FEEDBACK#'
      }
    }));

    return result.Items;
  }

  // Add this method to the DynamoDBService class
  async queryItems({ PK, SKPrefix }) {
    const result = await this.dynamodb.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: {
        ':pk': PK,
        ':sk': SKPrefix
      }
    }));

    return result.Items;
  }

  // Add these methods to handle channel config
  async getChannelConfig(sessionId, channelId) {
    try {
      const result = await this.dynamodb.send(new GetCommand({
        TableName: this.tableName,
        Key: {
          PK: `SESSION#${sessionId}`,
          SK: `CONFIG#${channelId}`
        }
      }));
      return result.Item;
    } catch (error) {
      console.error('Error getting channel config:', error);
      throw error;
    }
  }

  async createChannelConfig(sessionId, channelId) {
    try {
      await this.dynamodb.send(new PutCommand({
        TableName: this.tableName,
        Item: {
          PK: `SESSION#${sessionId}`,
          SK: `CONFIG#${channelId}`,
          createdAt: new Date().toISOString(),
          GSI1PK: `CHANNEL#${channelId}`,
          GSI1SK: `SESSION#${sessionId}`
        },
        ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)'
      }));
    } catch (error) {
      console.error('Error creating channel config:', error);
      throw error;
    }
  }
}

module.exports = new DynamoDBService(); 