// Removes a secret from any text before it is shown or logged.
export const redact = (value, token) => (token ? String(value ?? '').split(token).join('***') : String(value ?? ''));
