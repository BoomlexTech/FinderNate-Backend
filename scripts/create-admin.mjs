/**
 * Create the first admin account on a fresh database.
 *
 * A new Atlas cluster starts empty, and nothing in the app creates an admin.
 * The API does expose POST /admin/create-admin, but the whole admin router
 * sits behind verifyAdminJWT — so you need an admin to make an admin. This
 * breaks that circle, and is the only supported way to make the first one.
 *
 * Interactive (prompts for everything, password typing hidden):
 *   node scripts/create-admin.mjs
 *
 * Fields as flags, password still prompted:
 *   node scripts/create-admin.mjs --email you@example.com --username admin --name "Your Name"
 *
 * Fully non-interactive, for provisioning:
 *   node scripts/create-admin.mjs --email ... --username ... --name ... --password-file secret.txt
 *
 * The password is only ever read from a prompt or a file — never from a flag —
 * so it stays out of shell history and process listings. Delete the file after.
 * The Admin model's pre-save hook hashes it with bcrypt before storing.
 *
 * Safe to re-run: if an admin with that email or username exists the script
 * reports it and exits without touching anything.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import mongoose from 'mongoose';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(backendRoot, '.env') });

// pathToFileURL, not a raw path: on Windows an absolute path starts "C:\" and
// the ESM loader reads that as an unsupported "c:" URL scheme.
const { Admin } = await import(
  pathToFileURL(path.join(backendRoot, 'src', 'models', 'admin.models.js')).href
).then((m) => ({ Admin: m.Admin ?? m.default }));

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[++i];
  }
  return out;
}

// ONE readline interface for the whole run, created lazily. A second interface
// on the same stdin swallows the remaining input, which is why an earlier
// version of this script hung forever on the confirm prompt.
let rl = null;
function getRl() {
  if (!rl) {
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }
  return rl;
}

const ask = (question) =>
  new Promise((resolve) => getRl().question(question, (v) => resolve(v.trim())));

/**
 * Prompt without echoing. Masking needs clearLine/cursorTo, which exist only
 * on a TTY; when stdout is piped they are undefined and calling them throws.
 */
function askHidden(question) {
  // Nothing typed is echoed: readline's output is muted while the answer is
  // typed (the old redraw-on-keypress approach still let a character show).
  if (!process.stdout.isTTY) return ask(question);
  const r = getRl();
  return new Promise((resolve) => {
    const write = r._writeToOutput;
    let shownQuestion = false;
    r._writeToOutput = (text) => {
      if (!shownQuestion) {
        shownQuestion = true;
        write.call(r, text);
      }
    };
    r.question(question, (value) => {
      r._writeToOutput = write;
      process.stdout.write(String.fromCharCode(10));
      resolve(value.trim());
    });
  });
}

/** First non-empty line of a file, trimmed of any trailing CR. */
function readPasswordFile(filePath) {
  const file = path.resolve(filePath);
  if (!fs.existsSync(file)) throw new Error('password file not found: ' + file);
  const first = fs.readFileSync(file, 'utf8').split('\n')[0] || '';
  const value = first.replace('\r', '').trim();
  if (!value) throw new Error('password file is empty');
  return value;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const email = (args.email ?? (await ask('Admin email    : '))).toLowerCase();
  const username = (args.username ?? (await ask('Admin username : '))).toLowerCase();
  const fullName = args.name ?? (await ask('Full name      : '));

  if (!email || !username || !fullName) {
    throw new Error('email, username and name are all required.');
  }

  let password;
  if (args['password-file']) {
    // Reading a file sidesteps readline, which cannot be driven from piped
    // stdin: the stream hits EOF and the second prompt never resolves.
    password = readPasswordFile(args['password-file']);
  } else {
    password = await askHidden('Password (min 8): ');
    const confirm = await askHidden('Confirm password: ');
    if (password !== confirm) throw new Error('Passwords do not match.');
  }
  if (password.length < 8) {
    throw new Error('Password must be at least 8 characters.');
  }

  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set in .env');

  console.log('\nConnecting:', uri.replace(/\/\/([^:]+):[^@]*@/, '//$1:***@'));
  await mongoose.connect(uri);

  try {
    const clash = await Admin.findOne({ $or: [{ email }, { username }] });
    if (clash) {
      // Never overwrite an existing admin — that would silently change who
      // holds the keys to the whole system.
      const field = clash.email === email ? 'email' : 'username';
      throw new Error(
        'An admin already exists with that ' + field + '. Nothing changed.'
      );
    }

    const admin = await Admin.create({
      // uid is required and unique in the schema; a fresh ObjectId satisfies it.
      uid: new mongoose.Types.ObjectId().toString(),
      email,
      username,
      fullName,
      password, // hashed by the model's pre-save hook
      role: 'admin', // the model notes: admin IS the super admin
      isActive: true, // adminLogin rejects inactive accounts
      createdBy: null, // the first admin has no creator
    });

    console.log('\nAdmin created.');
    console.log('  id       :', admin._id.toString());
    console.log('  email    :', admin.email, '  <- log in with this');
    console.log('  username :', admin.username);
    console.log('  role     :', admin.role);
    console.log('  active   :', admin.isActive);
  } finally {
    await mongoose.disconnect();
  }
}

main()
  .then(() => {
    if (rl) rl.close();
    process.exit(0);
  })
  .catch((err) => {
    console.error('\nFAILED:', err.message);
    if (rl) rl.close();
    process.exit(1);
  });
