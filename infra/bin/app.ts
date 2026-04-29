#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { CognitoStack } from "../lib/cognito-stack";
import { StorageStack } from "../lib/storage-stack";
import { ComputeStack } from "../lib/compute-stack";
import { ApiStack } from "../lib/api-stack";
import { FrontendStack } from "../lib/frontend-stack";

const app = new cdk.App();
const env = {
  account: "173353905255",
  region: "us-east-1",
};

const cognitoStack = new CognitoStack(app, "BrainstormAI-CognitoStack", { env });

const storageStack = new StorageStack(app, "BrainstormAI-StorageStack", { env });

const computeStack = new ComputeStack(app, "BrainstormAI-ComputeStack", {
  env,
  wsCallbackUrl: "https://ve6modezl3.execute-api.us-east-1.amazonaws.com/prod",
  assetsBucket: storageStack.assetsBucket,
  notebooksTable: storageStack.notebooksTable,
  sourcesTable: storageStack.sourcesTable,
  jobsTable: storageStack.jobsTable,
  artifactsTable: storageStack.artifactsTable,
  wsConnectionsTable: storageStack.wsConnectionsTable,
  podcastSessionsTable: storageStack.podcastSessionsTable,
  userJobCountTable: storageStack.userJobCountTable,
  vectorsBucketName: storageStack.vectorsBucketName,
  vpc: storageStack.vpc,
  dbSecret: storageStack.dbSecret,
  dbEndpoint: storageStack.dbEndpoint,
  dbPort: storageStack.dbPort,
  dbSecurityGroup: storageStack.dbSecurityGroup,
});

new ApiStack(app, "BrainstormAI-ApiStack", {
  env,
  userPool: cognitoStack.userPool,
  userPoolClient: cognitoStack.userPoolClient,
  notebooksTable: storageStack.notebooksTable,
  sourcesTable: storageStack.sourcesTable,
  jobsTable: storageStack.jobsTable,
  artifactsTable: storageStack.artifactsTable,
  wsConnectionsTable: storageStack.wsConnectionsTable,
  podcastSessionsTable: storageStack.podcastSessionsTable,
  userJobCountTable: storageStack.userJobCountTable,
  assetsBucket: storageStack.assetsBucket,
  ingestionQueue: computeStack.ingestionQueue,
  podcastQueue: computeStack.podcastQueue,
  mindmapQueue: computeStack.mindmapQueue,
  quizQueue: computeStack.quizQueue,
  summaryQueue: computeStack.summaryQueue,
  vectorsBucketName: storageStack.vectorsBucketName,
});

new FrontendStack(app, "BrainstormAI-FrontendStack", { env });
