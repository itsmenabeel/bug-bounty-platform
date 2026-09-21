import { OAuth2Client } from "google-auth-library";
import { env } from "./env";

// Null when GOOGLE_CLIENT_ID is unset; the endpoint then reports Google login as unavailable.
export const googleClient = env.GOOGLE_CLIENT_ID ? new OAuth2Client(env.GOOGLE_CLIENT_ID) : null;
