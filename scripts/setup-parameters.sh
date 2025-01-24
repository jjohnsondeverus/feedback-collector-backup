#!/bin/bash

# Environment (dev or prod)
ENV=$1

# Check if environment is provided
if [ -z "$ENV" ]; then
  echo "Usage: $0 <environment>"
  exit 1
fi

# Load values from .env file
source .env

# Create/update parameters
aws ssm put-parameter --name "/feedback-collector/${ENV}/SLACK_BOT_TOKEN" --value "$SLACK_BOT_TOKEN" --type "SecureString" --overwrite
aws ssm put-parameter --name "/feedback-collector/${ENV}/SLACK_APP_TOKEN" --value "$SLACK_APP_TOKEN" --type "SecureString" --overwrite
aws ssm put-parameter --name "/feedback-collector/${ENV}/SLACK_SIGNING_SECRET" --value "$SLACK_SIGNING_SECRET" --type "SecureString" --overwrite

aws ssm put-parameter --name "/feedback-collector/${ENV}/JIRA_HOST" --value "$JIRA_HOST" --type "SecureString" --overwrite
aws ssm put-parameter --name "/feedback-collector/${ENV}/JIRA_USERNAME" --value "$JIRA_USERNAME" --type "SecureString" --overwrite
aws ssm put-parameter --name "/feedback-collector/${ENV}/JIRA_API_TOKEN" --value "$JIRA_API_TOKEN" --type "SecureString" --overwrite

aws ssm put-parameter --name "/feedback-collector/${ENV}/OPENAI_API_KEY" --value "$OPENAI_API_KEY" --type "SecureString" --overwrite
aws ssm put-parameter --name "/feedback-collector/${ENV}/OPENAI_MODEL" --value "$OPENAI_MODEL" --type "SecureString" --overwrite

echo "Parameters created/updated for environment: $ENV" 