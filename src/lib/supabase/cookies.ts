export const AUTH_COOKIE_OPTIONS = {
  name: 'chem-immuno-cbh-auth',
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.NODE_ENV === 'production',
  path: '/',
};
