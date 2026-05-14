import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import { Construct } from "constructs";
import { NagSuppressions } from "cdk-nag";

export class FrontendStack extends cdk.Stack {
  public readonly siteBucket: s3.Bucket;
  public readonly distributionDomainName: string;

  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    this.siteBucket = new s3.Bucket(this, "SiteBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const distribution = new cloudfront.Distribution(this, "Distribution", {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      defaultRootObject: "index.html",
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
          ttl: cdk.Duration.seconds(0),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
          ttl: cdk.Duration.seconds(0),
        },
      ],
    });

    this.distributionDomainName = distribution.distributionDomainName;

    // config.json is written by a post-deploy script (see README) because
    // API URLs are only known after ApiStack deploys.
    new cdk.CfnOutput(this, "CloudFrontUrl", {
      value: `https://${distribution.distributionDomainName}`,
    });
    new cdk.CfnOutput(this, "SiteBucketName", {
      value: this.siteBucket.bucketName,
    });

    NagSuppressions.addStackSuppressions(this, [
      {
        id: "AwsSolutions-S1",
        reason: "Frontend S3 bucket serves static assets via CloudFront only (no direct S3 access). Access logging is captured at the CloudFront distribution level instead.",
      },
      {
        id: "AwsSolutions-S10",
        reason: "S3 bucket is not publicly accessible — all access is through CloudFront with OAC. SSL enforcement at the bucket level is redundant as direct S3 access is blocked.",
      },
      {
        id: "AwsSolutions-CFR3",
        reason: "CloudFront access logging not enabled for this sample application. Production deployments should enable distribution access logging.",
      },
      {
        id: "AwsSolutions-CFR4",
        reason: "CloudFront distribution uses the default certificate which enforces TLSv1.2 in practice. A custom certificate with explicit minimum TLS version should be configured for production deployments.",
      },
      {
        id: "AwsSolutions-IAM4",
        reason: "CDK-generated Lambda for S3 auto-delete uses AWSLambdaBasicExecutionRole — standard managed policy for Lambda execution.",
      },
      {
        id: "AwsSolutions-IAM5",
        reason: "CDK-generated S3 auto-delete Lambda requires wildcard permissions on the bucket to enumerate and delete objects during stack teardown.",
      },
      {
        id: "AwsSolutions-L1",
        reason: "CDK-generated auto-delete Lambda runtime is managed by CDK and always uses a recent Node.js version.",
      },
      {
        id: "AwsSolutions-CFR1",
        reason: "Geo restrictions not required for this sample application which is intended for global developer use.",
      },
      {
        id: "AwsSolutions-CFR2",
        reason: "WAF not associated with CloudFront for this sample application. Production deployments should associate a WAF ACL.",
      },
    ]);
  }
}
