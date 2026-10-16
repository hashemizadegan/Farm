/** Prints a development bearer token. Usage: pnpm --filter @metafarm/api dev-token [subject] */
import { mintDevToken } from "../auth/dev";

const secret = process.env.DEV_AUTH_SECRET;
if (!secret || process.env.APP_ENV === "production" || process.env.APP_ENV === "staging") {
  console.error("DEV_AUTH_SECRET must be set and APP_ENV must be development or test");
  process.exit(1);
}
const subject = process.argv[2] ?? "dev-user";
console.log(await mintDevToken(secret, subject, subject));
