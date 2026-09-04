#!/usr/bin/env node
import "source-map-support/register"
import * as cdk from "aws-cdk-lib"
import { AgentcoreDemoStack } from "../lib/agentcore-demo-stack"

const app = new cdk.App()

new AgentcoreDemoStack(app, "AgentcoreGatewayTargetApiGatewayDemo", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "eu-west-1",
  },
})
