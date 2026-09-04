# AgentCore Gateway + Private REST API Demo

CDK (TypeScript) demo of an Amazon Bedrock AgentCore Gateway REST API
target that reaches an API Gateway backend through a VPC, instead of over
the public internet — matching the pattern in the AWS blog post
["Configuring Amazon Bedrock AgentCore Gateway for secure access to private resources"](https://aws.amazon.com/blogs/machine-learning/configuring-amazon-bedrock-agentcore-gateway-for-secure-access-to-private-resources/).

## What this deploys

- A VPC with an isolated subnet and an interface VPC endpoint for
  `execute-api`.
- A Lambda (`src/books-handler.ts`) returning a small list of Norwegian
  books as `{ books: [...] }`.
- An API Gateway (`GET /books`) in front of the Lambda. Its endpoint type
  is `REGIONAL` — API Gateway's "public" type — because the AgentCore
  Gateway's `mcp.apiGateway` target type only supports public endpoint
  types. Access is still locked down: a resource policy denies
  `execute-api:Invoke` from anywhere except the VPC endpoint above.
- An AgentCore `Gateway` (`agentcore.Gateway`) with an API Gateway target
  (`gateway.addApiGatewayTarget()`) exposing `GET /books` as a tool. The
  target's `privateEndpoint.managedVpcResource` is set (via the L1 escape
  hatch — it's a typed property, no `addPropertyOverride` needed) so the
  Gateway routes its calls through the VPC and out via the VPC endpoint,
  rather than over the public internet. This is what actually makes the
  access "private" end-to-end, even though the API's endpoint type is
  REGIONAL.
- A bare `agentcore.CfnHarness` — default create only, no Strands code, no
  tools/skills/memory wiring.

## Why REGIONAL, not PRIVATE, for the API Gateway?

`ApiGatewayTargetConfiguration`'s CDK docs state the backing REST API
"must use a public endpoint type" (i.e. `REGIONAL` or `EDGE`, not
`PRIVATE`). So instead of making the API Gateway itself unreachable from
the internet (`PRIVATE` endpoint type), this demo keeps it `REGIONAL` and
restricts *who* can invoke it via a resource policy scoped to the VPC
endpoint. The AgentCore Gateway is configured to always call in through
that VPC endpoint (`privateEndpoint.managedVpcResource`), so in practice
it never touches the public internet — the net effect matches the blog's
"private resource" architecture.

## Deploy

```bash
npm install
npx cdk synth      # validate the stack synthesizes
npx cdk deploy      # creates real AWS resources
```

## Smoke test

1. Confirm the API Gateway stage is actually deployed — this was the root
   cause of an earlier empty-content bug:
   ```bash
   aws apigateway get-stages --rest-api-id <BooksApi id from CfnOutput/console>
   ```
2. Invoke the Gateway's tool for `GET /books` (via awscurl or an MCP
   client — see `test-agentcore-gateway.sh` in the `pm-server-side/server-side`
   repo root for the request shape) and confirm the 3 books come back
   non-empty.
3. Confirm the harness reaches `CREATE_COMPLETE`:
   ```bash
   aws bedrock-agentcore-control get-harness --harness-id <id>
   ```

## Teardown

```bash
npx cdk destroy
```
