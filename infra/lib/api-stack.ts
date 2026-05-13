import * as cdk from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as apigatewayv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigatewayv2integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as apigatewayv2authorizers from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import { NagSuppressions } from "cdk-nag";
import * as path from "path";
import { execSync } from "child_process";

interface ApiStackProps extends cdk.StackProps {
  userPool: cognito.UserPool;
  userPoolClient: cognito.UserPoolClient;
  notebooksTable: dynamodb.Table;
  sourcesTable: dynamodb.Table;
  jobsTable: dynamodb.Table;
  artifactsTable: dynamodb.Table;
  wsConnectionsTable: dynamodb.Table;
  podcastSessionsTable: dynamodb.Table;
  userJobCountTable: dynamodb.Table;
  assetsBucket: s3.Bucket;
  ingestionQueue: sqs.Queue;
  podcastQueue: sqs.Queue;
  mindmapQueue: sqs.Queue;
  quizQueue: sqs.Queue;
  summaryQueue: sqs.Queue;
  vectorsBucketName: string;
}

export class ApiStack extends cdk.Stack {
  public readonly apiUrl: string;
  public readonly wsUrl: string;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const commonEnv = {
      NOTEBOOKS_TABLE: props.notebooksTable.tableName,
      SOURCES_TABLE: props.sourcesTable.tableName,
      JOBS_TABLE: props.jobsTable.tableName,
      ARTIFACTS_TABLE: props.artifactsTable.tableName,
      WS_CONNECTIONS_TABLE: props.wsConnectionsTable.tableName,
      PODCAST_SESSIONS_TABLE: props.podcastSessionsTable.tableName,
      USER_JOB_COUNT_TABLE: props.userJobCountTable.tableName,
      S3_BUCKET: props.assetsBucket.bucketName,
      S3_VECTORS_BUCKET: props.vectorsBucketName,
      INGESTION_QUEUE_URL: props.ingestionQueue.queueUrl,
      PODCAST_QUEUE_URL: props.podcastQueue.queueUrl,
      MINDMAP_QUEUE_URL: props.mindmapQueue.queueUrl,
      QUIZ_QUEUE_URL: props.quizQueue.queueUrl,
      SUMMARY_QUEUE_URL: props.summaryQueue.queueUrl,
      USER_POOL_ID: props.userPool.userPoolId,
      DAILY_TOKEN_LIMIT: "1000000",
    };

    const makeLambda = (name: string, handlerPath: string) => {
      const fn = new lambda.Function(this, name, {
        runtime: lambda.Runtime.PYTHON_3_12,
        timeout: cdk.Duration.seconds(30),
        memorySize: 256,
        environment: commonEnv,
        functionName: `brainstormai-${name.toLowerCase()}`,
        code: lambda.Code.fromAsset(`../backend/lambdas/${handlerPath}`),
        handler: "handler.lambda_handler",
        logGroup: new logs.LogGroup(this, `${name}LogGroup`, {
          logGroupName: `/aws/lambda/brainstormai-${name.toLowerCase()}`,
          retention: logs.RetentionDays.THREE_MONTHS,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      });
      props.notebooksTable.grantReadWriteData(fn);
      props.sourcesTable.grantReadWriteData(fn);
      props.jobsTable.grantReadWriteData(fn);
      props.artifactsTable.grantReadWriteData(fn);
      props.wsConnectionsTable.grantReadWriteData(fn);
      props.podcastSessionsTable.grantReadWriteData(fn);
      props.userJobCountTable.grantReadWriteData(fn);
      props.assetsBucket.grantReadWrite(fn);
      props.ingestionQueue.grantSendMessages(fn);
      props.podcastQueue.grantSendMessages(fn);
      props.mindmapQueue.grantSendMessages(fn);
      props.quizQueue.grantSendMessages(fn);
      props.summaryQueue.grantSendMessages(fn);
      return fn;
    };

    // Notebooks Lambda bundles its own boto3 (>= 1.38) because the runtime-bundled
    // boto3 (~1.34) predates the S3 Vectors service.  We use local bundling
    // (pip on the host) to avoid Docker socket issues in some environments.
    const notebooksAssetPath = path.resolve(__dirname, "../../backend/lambdas/notebooks");
    const notebooksFn = new lambda.Function(this, "Notebooks", {
      runtime: lambda.Runtime.PYTHON_3_12,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: commonEnv,
      functionName: "brainstormai-notebooks",
      logGroup: new logs.LogGroup(this, "NotebooksLogGroup", {
        logGroupName: "/aws/lambda/brainstormai-notebooks",
        retention: logs.RetentionDays.THREE_MONTHS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      code: lambda.Code.fromAsset(notebooksAssetPath, {
        bundling: {
          image: lambda.Runtime.PYTHON_3_12.bundlingImage,
          local: {
            tryBundle(outputDir: string) {
              execSync(
                `pip install -r requirements.txt -t "${outputDir}" --quiet && cp handler.py "${outputDir}/"`,
                { cwd: notebooksAssetPath, stdio: "inherit" },
              );
              return true;
            },
          },
          command: [
            "bash", "-c",
            "pip install -r requirements.txt -t /asset-output --quiet && cp handler.py /asset-output/",
          ],
        },
      }),
      handler: "handler.lambda_handler",
    });
    props.notebooksTable.grantReadWriteData(notebooksFn);
    props.sourcesTable.grantReadWriteData(notebooksFn);
    props.jobsTable.grantReadWriteData(notebooksFn);
    props.artifactsTable.grantReadWriteData(notebooksFn);
    props.wsConnectionsTable.grantReadWriteData(notebooksFn);
    props.podcastSessionsTable.grantReadWriteData(notebooksFn);
    props.userJobCountTable.grantReadWriteData(notebooksFn);
    props.assetsBucket.grantReadWrite(notebooksFn);
    props.ingestionQueue.grantSendMessages(notebooksFn);
    props.podcastQueue.grantSendMessages(notebooksFn);
    props.mindmapQueue.grantSendMessages(notebooksFn);
    props.quizQueue.grantSendMessages(notebooksFn);
    props.summaryQueue.grantSendMessages(notebooksFn);
    notebooksFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "s3vectors:CreateIndex",
          "s3vectors:DeleteIndex",
          "s3vectors:ListIndexes",
        ],
        resources: ["*"],
      })
    );
    const sourcesFn = makeLambda("Sources", "sources");
    const jobsFn = makeLambda("Jobs", "jobs");
    const artifactsFn = makeLambda("Artifacts", "artifacts");
    const websocketFn = makeLambda("Websocket", "websocket");

    // ── REST API ──
    const api = new apigateway.RestApi(this, "RestApi", {
      restApiName: "brainstormai-api",
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ["Content-Type", "Authorization"],
      },
    });

    const cognitoAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(this, "Authorizer", {
      cognitoUserPools: [props.userPool],
    });

    const authOptions: apigateway.MethodOptions = {
      authorizer: cognitoAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    };

    const notebooksResource = api.root.addResource("notebooks");
    notebooksResource.addMethod("GET", new apigateway.LambdaIntegration(notebooksFn), authOptions);
    notebooksResource.addMethod("POST", new apigateway.LambdaIntegration(notebooksFn), authOptions);

    const notebookResource = notebooksResource.addResource("{notebookId}");
    notebookResource.addMethod("GET", new apigateway.LambdaIntegration(notebooksFn), authOptions);
    notebookResource.addMethod("PATCH", new apigateway.LambdaIntegration(notebooksFn), authOptions);
    notebookResource.addMethod("DELETE", new apigateway.LambdaIntegration(notebooksFn), authOptions);

    const sourcesResource = notebookResource.addResource("sources");
    sourcesResource.addMethod("GET", new apigateway.LambdaIntegration(sourcesFn), authOptions);
    sourcesResource.addResource("upload-url").addMethod(
      "POST", new apigateway.LambdaIntegration(sourcesFn), authOptions
    );
    sourcesResource.addResource("url").addMethod(
      "POST", new apigateway.LambdaIntegration(sourcesFn), authOptions
    );
    sourcesResource.addResource("text").addMethod(
      "POST", new apigateway.LambdaIntegration(sourcesFn), authOptions
    );

    const sourceResource = sourcesResource.addResource("{sourceId}");
    sourceResource.addMethod("DELETE", new apigateway.LambdaIntegration(sourcesFn), authOptions);
    sourceResource.addResource("ingest").addMethod("POST", new apigateway.LambdaIntegration(sourcesFn), authOptions);

    const jobsResource = notebookResource.addResource("jobs");
    jobsResource.addMethod("GET", new apigateway.LambdaIntegration(jobsFn), authOptions);
    jobsResource.addMethod("POST", new apigateway.LambdaIntegration(jobsFn), authOptions);

    const jobResource = jobsResource.addResource("{jobId}");
    jobResource.addMethod("GET", new apigateway.LambdaIntegration(jobsFn), authOptions);
    jobResource.addMethod("DELETE", new apigateway.LambdaIntegration(jobsFn), authOptions);

    const artifactsResource = notebookResource.addResource("artifacts");
    artifactsResource.addMethod("GET", new apigateway.LambdaIntegration(artifactsFn), authOptions);

    const artifactResource = artifactsResource.addResource("{artifactId}");
    artifactResource.addMethod("GET", new apigateway.LambdaIntegration(artifactsFn), authOptions);

    this.apiUrl = api.url;

    // ── WebSocket API ──
    const wsAuthorizerFn = new lambda.Function(this, "WsAuthorizerFn", {
      runtime: lambda.Runtime.PYTHON_3_12,
      timeout: cdk.Duration.seconds(10),
      memorySize: 128,
      functionName: "brainstormai-ws-authorizer",
      code: lambda.Code.fromAsset("../backend/lambdas/ws_authorizer"),
      handler: "handler.lambda_handler",
      environment: {
        USER_POOL_ID: props.userPool.userPoolId,
      },
      logGroup: new logs.LogGroup(this, "WsAuthorizerLogGroup", {
        logGroupName: "/aws/lambda/brainstormai-ws-authorizer",
        retention: logs.RetentionDays.THREE_MONTHS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    const wsAuthorizer = new apigatewayv2authorizers.WebSocketLambdaAuthorizer(
      "WsAuthorizer",
      wsAuthorizerFn,
      {
        authorizerName: "CognitoJwtAuthorizer",
        identitySource: ["route.request.querystring.token"],
      }
    );

    // Each route needs its own integration object so CDK generates a separate
    // lambda:InvokeFunction permission per route ARN.
    const wsApi = new apigatewayv2.WebSocketApi(this, "WsApi", {
      apiName: "brainstormai-ws",
      connectRouteOptions: {
        integration: new apigatewayv2integrations.WebSocketLambdaIntegration("WsConnectIntegration", websocketFn),
        authorizer: wsAuthorizer,
      },
      disconnectRouteOptions: {
        integration: new apigatewayv2integrations.WebSocketLambdaIntegration("WsDisconnectIntegration", websocketFn),
      },
      defaultRouteOptions: {
        integration: new apigatewayv2integrations.WebSocketLambdaIntegration("WsDefaultIntegration", websocketFn),
      },
    });

    const wsStage = new apigatewayv2.WebSocketStage(this, "WsStage", {
      webSocketApi: wsApi,
      stageName: "prod",
      autoDeploy: true,
    });

    // Allow websocket Lambda to push messages back to clients and call Bedrock for Q&A
    websocketFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["execute-api:ManageConnections"],
        resources: [`arn:aws:execute-api:${this.region}:${this.account}:${wsApi.apiId}/*`],
      })
    );
    websocketFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel", "polly:SynthesizeSpeech"],
        resources: ["*"],
      })
    );
    websocketFn.addEnvironment("WS_ENDPOINT", wsStage.callbackUrl);

    this.wsUrl = wsStage.url;

    new cdk.CfnOutput(this, "ApiUrl", { value: this.apiUrl });
    new cdk.CfnOutput(this, "WsUrl", { value: this.wsUrl });

    NagSuppressions.addStackSuppressions(this, [
      {
        id: "AwsSolutions-APIG4",
        reason: "All REST API methods use Cognito User Pool authorizer (authorizationType: COGNITO). The WebSocket $connect route uses a Lambda REQUEST authorizer validating the ?token= JWT. cdk-nag false-positive on v2 WebSocket routes.",
      },
      {
        id: "AwsSolutions-APIG1",
        reason: "Access logging not enabled for this sample application. Production deployments should enable access logs on API Gateway stages.",
      },
      {
        id: "AwsSolutions-APIG2",
        reason: "Basic request validation not configured — input validation is performed inside the Lambda handlers. Production deployments should add request models.",
      },
      {
        id: "AwsSolutions-APIG6",
        reason: "CloudWatch execution logging not enabled for this sample. Production deployments should enable stage-level logging.",
      },
      {
        id: "AwsSolutions-IAM4",
        reason: "AWSLambdaBasicExecutionRole and AmazonAPIGatewayPushToCloudWatchLogs are standard managed policies for Lambda execution and API Gateway logging. Custom policies would provide no additional security benefit for this sample.",
      },
      {
        id: "AwsSolutions-IAM5",
        reason: "Wildcard resources required: Bedrock/Polly do not support resource-level restrictions; execute-api:ManageConnections is scoped to the specific API; S3/DynamoDB wildcards are CDK-generated grant patterns scoped to named resources.",
      },
      {
        id: "AwsSolutions-L1",
        reason: "All Lambda functions use Python 3.12 which is the latest stable Python runtime available in Lambda.",
      },
      {
        id: "AwsSolutions-APIG3",
        reason: "WAFv2 web ACL not associated with API Gateway for this sample application. Production deployments should associate a WAF ACL for additional protection.",
      },
    ]);
  }
}
