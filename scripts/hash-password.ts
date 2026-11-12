/**
 * Generate the value for ACCESS_PASSWORD_HASH.
 *
 *   npm run hash-password            (prompts; input is hidden)
 *   echo "my password" | npm run hash-password
 *
 * Passing the password as an argument also works but leaves it in your shell history.
 */
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { hashPassword } from '../packages/core/src/auth';

function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    let muted = false;
    const output = new Writable({
      write(chunk: Buffer | string, _encoding, callback) {
        if (!muted) process.stdout.write(chunk);
        callback();
      },
    });
    const rl = createInterface({ input: process.stdin, output, terminal: true });
    rl.question(prompt, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    muted = true;
  });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

async function main(): Promise<void> {
  let password = process.argv[2];
  if (password === undefined) {
    password = process.stdin.isTTY ? await readHidden('Access password: ') : await readStdin();
  }
  if (password.length < 12) {
    console.error('Use a password of at least 12 characters: this is the only thing protecting the site.');
    process.exit(1);
  }
  console.log(`\nACCESS_PASSWORD_HASH=${await hashPassword(password)}\n`);
  console.log('Put that line in your .env (local) or your host\'s environment variables (production).');
  console.log('Do not also set ACCESS_PASSWORD.');
}

void main();
