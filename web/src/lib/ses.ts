import { AwsClient } from 'aws4fetch';

/** Plain-text mail via SES v2. The sender identity is verified account-side. */
export async function sendMail(
  env: Env,
  to: string,
  subject: string,
  text: string,
): Promise<void> {
  const aws = new AwsClient({
    accessKeyId: env.SES_ACCESS_KEY_ID,
    secretAccessKey: env.SES_SECRET_ACCESS_KEY,
    region: env.SES_REGION,
    service: 'ses',
  });
  const res = await aws.fetch(
    `https://email.${env.SES_REGION}.amazonaws.com/v2/email/outbound-emails`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        FromEmailAddress: env.SES_FROM,
        Destination: { ToAddresses: [to] },
        Content: {
          Simple: {
            Subject: { Data: subject, Charset: 'UTF-8' },
            Body: { Text: { Data: text, Charset: 'UTF-8' } },
          },
        },
      }),
    },
  );
  if (!res.ok) throw new Error(`SES ${res.status}: ${await res.text()}`);
}
