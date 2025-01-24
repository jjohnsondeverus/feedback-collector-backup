const AWS = require('aws-sdk');

class DynamoDBService {
  constructor(config = {}) {
    this.dynamodb = new AWS.DynamoDB.DocumentClient({
      region: process.env.AWS_REGION || 'us-east-1',
      ...(process.env.AWS_ACCESS_KEY_ID === 'local' && {
        endpoint: 'http://localhost:8000',
        credentials: {
          accessKeyId: 'local',
          secretAccessKey: 'local'
        }
      })
    });
    this.tableName = process.env.DYNAMODB_TABLE || 'feedback-sessions';
  }

  async createSession({ sessionId, userId, channels, startDate, endDate, status }) {
    const params = {
      TableName: this.tableName,
      Item: {
        PK: sessionId,
        SK: 'META',
        userId,
        channels,
        startDate,
        endDate,
        status,
        createdAt: new Date().toISOString()
      }
    };

    await this.dynamodb.put(params).promise();
    return sessionId;
  }

  async addFeedbackItems({ sessionId, channelId, items }) {
    const batchWrites = items.map((item, index) => ({
      PutRequest: {
        Item: {
          PK: sessionId,
          SK: `FEEDBACK#${channelId}#${index}`,
          GSI1PK: `CHANNEL#${channelId}`,
          GSI1SK: sessionId,
          ...item,
          createdAt: new Date().toISOString(),
          included: true,
          editable: true
        }
      }
    }));

    // Split into chunks of 25 (DynamoDB batch write limit)
    for (let i = 0; i < batchWrites.length; i += 25) {
      const batch = batchWrites.slice(i, i + 25);
      await this.dynamodb.batchWrite({
        RequestItems: {
          [this.tableName]: batch
        }
      }).promise();
    }
  }

  async getFeedbackItems(sessionId, channelId) {
    const params = {
      TableName: this.tableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: {
        ':pk': sessionId,
        ':sk': 'FEEDBACK#'
      }
    };

    const result = await this.dynamodb.query(params).promise();
    return result.Items || [];
  }
}

module.exports = { DynamoDBService }; 