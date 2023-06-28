/// <reference lib="deno.window" />
import { Secret } from 'https://deno.land/x/cliffy@v0.25.7/prompt/secret.ts';
import { hash } from 'https://deno.land/x/argon2ian@1.0.5/src/argon2.ts';
import { encode } from 'https://deno.land/std@0.192.0/encoding/base64url.ts';

const password = await Secret.prompt('New admin password');
const salt = crypto.getRandomValues(new Uint8Array(32));
console.log('ADMIN_PASSWORD_HASH=' + encode(hash(new TextEncoder().encode(password), salt)));
console.log('ADMIN_PASSWORD_SALT=' + encode(salt));
