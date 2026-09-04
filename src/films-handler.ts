// Lambda handler backing the private API Gateway's GET /films route.
// Mirrors books-handler.ts's shape/pattern: a top-level "films" field so the
// OpenAPI schema exposed through the AgentCore Gateway OpenAPI target matches.

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda"

interface Film {
  id: number
  title: string
  director: string
  year: number
}

const films: Film[] = [
  { id: 1, title: "Kon-Tiki", director: "Joachim Rønning", year: 2012 },
  { id: 2, title: "Max Manus", director: "Joachim Rønning", year: 2008 },
  { id: 3, title: "Detektiv Downs", director: "Bård Breien", year: 2013 },
]

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  console.log("Received event:", JSON.stringify(event))

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ films }),
  }
}
