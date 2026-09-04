import * as cdk from "aws-cdk-lib"
import * as agentcore from "aws-cdk-lib/aws-bedrockagentcore"
import * as apigateway from "aws-cdk-lib/aws-apigateway"
import * as ec2 from "aws-cdk-lib/aws-ec2"
import * as iam from "aws-cdk-lib/aws-iam"
import * as lambda from "aws-cdk-lib/aws-lambda"
import type { Construct } from "constructs"
import * as path from "path"

export class AgentcoreDemoStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props)

    // A small VPC for the execute-api interface endpoint. The AgentCore Gateway
    // routes into this VPC (via privateEndpoint.managedVpcResource below) instead
    // of calling the API Gateway over the public internet.
    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: "private", subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    })

    const vpcEndpointSg = new ec2.SecurityGroup(this, "VpcEndpointSg", {
      vpc,
      description: "Allows inbound HTTPS to the execute-api VPC endpoint",
      allowAllOutbound: true,
    })
    vpcEndpointSg.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(443))

    const executeApiEndpoint = vpc.addInterfaceEndpoint("ExecuteApiEndpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.APIGATEWAY,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [vpcEndpointSg],
      privateDnsEnabled: true,
    })

    const booksFunction = new lambda.Function(this, "BooksFunction", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "books-handler.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "..", "src")),
    })

    // REGIONAL is API Gateway's "public" endpoint type (as opposed to PRIVATE).
    // AgentCore Gateway's mcp.apiGateway target only supports public endpoint
    // types, so access is instead restricted here via a resource policy that
    // only allows requests arriving through our VPC endpoint. The AgentCore
    // Gateway target routes through that same VPC endpoint (via
    // privateEndpoint.managedVpcResource below), so it never touches the
    // public internet even though the API's endpoint type is "public".
    const booksApi = new apigateway.RestApi(this, "BooksApi", {
      endpointConfiguration: { types: [apigateway.EndpointType.REGIONAL] },
      policy: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            effect: iam.Effect.DENY,
            principals: [new iam.AnyPrincipal()],
            actions: ["execute-api:Invoke"],
            resources: ["execute-api:/*"],
            conditions: {
              StringNotEquals: { "aws:SourceVpce": executeApiEndpoint.vpcEndpointId },
            },
          }),
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            principals: [new iam.AnyPrincipal()],
            actions: ["execute-api:Invoke"],
            resources: ["execute-api:/*"],
          }),
        ],
      }),
      deploy: true,
      deployOptions: { stageName: "sit" },
    })

    const books = booksApi.root.addResource("books")
    books.addMethod("GET", new apigateway.LambdaIntegration(booksFunction))

    const gateway = new agentcore.Gateway(this, "Gateway", {
      gatewayName: "agentcore-demo-books-gateway",
    })

    const target = gateway.addApiGatewayTarget("BooksTarget", {
      restApi: booksApi,
      apiGatewayToolConfiguration: {
        toolFilters: [{ filterPath: "/books", methods: [agentcore.ApiGatewayHttpMethod.GET] }],
      },
    })

    // The L2 addApiGatewayTarget() has no VPC-routing option, so we reach into
    // the generated L1 to set privateEndpoint directly — a typed property, no
    // addPropertyOverride escape hatch required.
    const cfnTarget = target.node.defaultChild as agentcore.CfnGatewayTarget
    cfnTarget.privateEndpoint = {
      managedVpcResource: {
        vpcIdentifier: vpc.vpcId,
        subnetIds: vpc.isolatedSubnets.map((subnet) => subnet.subnetId),
        securityGroupIds: [vpcEndpointSg.securityGroupId],
        endpointIpAddressType: "IPV4",
      },
    }

    const harnessRole = new iam.Role(this, "HarnessRole", {
      assumedBy: new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com"),
    })
    harnessRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
        resources: ["*"],
      }),
    )

    // Bare default harness: no Strands code, no tools/skills/memory wiring —
    // just the required create-time fields.
    new agentcore.CfnHarness(this, "Harness", {
      harnessName: "AgentcoreDemoHarness",
      executionRoleArn: harnessRole.roleArn,
      model: {
        bedrockModelConfig: {
          modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
        },
      },
    })

    new cdk.CfnOutput(this, "BooksApiUrl", { value: booksApi.url })
    new cdk.CfnOutput(this, "GatewayId", { value: gateway.gatewayId })
    new cdk.CfnOutput(this, "GatewayArn", { value: gateway.gatewayArn })
  }
}
