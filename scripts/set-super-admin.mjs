/**
 * Set the super admin's email and password.
 *
 *   node scripts/set-super-admin.mjs --email support@findernate.com
 *
 * What it changes:
 * - An admin with that email already exists: that account becomes the super
 *   admin (createdBy cleared) and gets the new password.
 * - Otherwise the existing super admin (the admin nobody created) is moved to
 *   that email and gets the new password. With several, the oldest is used.
 * - No admin at all: a super admin is created with that email.
 * Every session of that account is ended and any pending reset link is
 * cancelled. It shows what it will do and asks you to type "yes" first.
 *
 * The password is asked for with typing hidden (or read with
 * --password-file), never taken from a flag, so it stays out of shell history
 * and process listings. Afterwards the admin panel's "Forgot password?" works
 * for this email too.
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

const { Admin } = await import(
  pathToFileURL(path.join(backendRoot, 'src', 'models', 'admin.models.js')).href
).then((m) => ({ Admin: m.Admin ?? m.default }));
const { passwordProblem } = await import(
  pathToFileURL(path.join(backendRoot, 'src', 'controllers', 'admin', 'passwordReset.controllers.js')).href
);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[++i];
  }
  return out;
}

let rl = null;
const getRl = () => (rl ??= readline.createInterface({ input: process.stdin, output: process.stdout }));
const ask = (question) => new Promise((resolve) => getRl().question(question, (v) => resolve(v.trim())));

function askHidden(question) {
  const canMask = Boolean(process.stdout.isTTY && process.stdout.clearLine);
  if (!canMask) return ask(question);
  return new Promise((resolve) => {
    const onData = (char) => {
      const c = char.toString();
      if (c !== '\n' && c !== '\r' && c !== '') {
        process.stdout.clearLine(0);
        process.stdout.cursorTo(0);
        process.stdout.write(question);
      }
    };
    process.stdin.on('data', onData);
    getRl().question(question, (value) => {
      process.stdin.removeListener('data', onData);
      process.stdout.write('\n');
      resolve(value.trim());
    });
  });
}

function readPasswordFile(filePath) {
  const file = path.resolve(filePath);
  if (!fs.existsSync(file)) throw new Error('password file not found: ' + file);
  const value = (fs.readFileSync(file, 'utf8').split('\n')[0] || '').replace('\r', '').trim();
  if (!value) throw new Error('password file is empty');
  return value;
}

const isSuper = (a) => a.role === 'super_admin' || a.createdBy == null;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const email = String(args.email ?? (await ask('Super admin email: '))).trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('A valid email is required.');

  let password;
  if (args['password-file']) {
    password = readPasswordFile(args['password-file']);
  } else {
    password = await askHidden('New password      : ');
    const confirm = await askHidden('Confirm password  : ');
    if (password !== confirm) throw new Error('Passwords do not match.');
  }
  const problem = passwordProblem(password);
  if (problem) throw new Error(problem);

  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set in .env');
  console.log('\nConnecting:', uri.replace(/\/\/([^:]+):[^@]*@/, '//$1:***@'));
  await mongoose.connect(uri);

  try {
    const all = await Admin.find({}).select('email username fullName role createdBy isActive createdAt').sort({ createdAt: 1 }).lean();
    const byEmail = all.find((a) => a.email === email);
    const supers = all.filter(isSuper);
    const target = byEmail || supers[0] || null;

    console.log(`\nAdmins in this database: ${all.length} (super admins: ${supers.length})`);
    if (target) {
      console.log('Will update this admin:');
      console.log('  username :', target.username);
      console.log('  email    :', target.email, target.email === email ? '' : `->  ${email}`);
      console.log('  super    :', isSuper(target) ? 'yes' : 'no  ->  yes');
      console.log('  password :  set to the one you typed');
    } else {
      console.log(`Will create a super admin: ${email} (username "support").`);
    }

    const ok = (await ask('\nType yes to continue: ')).toLowerCase();
    if (ok !== 'yes') {
      console.log('Nothing changed.');
      return;
    }

    if (target) {
      const doc = await Admin.findById(target._id).select('+refreshToken +passwordResetTokenHash +passwordResetExpires');
      doc.email = email;
      doc.password = password; // hashed by the model's pre-save hook
      doc.createdBy = null; // the admin nobody created is the super admin
      if (doc.role !== 'super_admin') doc.role = 'admin';
      doc.isActive = true;
      doc.refreshToken = undefined;
      doc.passwordResetTokenHash = undefined;
      doc.passwordResetExpires = undefined;
      await doc.save({ validateBeforeSave: false });
      console.log('\nDone. Sign in at /admin/login with', email);
    } else {
      const taken = await Admin.findOne({ username: 'support' }).lean();
      const created = await Admin.create({
        uid: new mongoose.Types.ObjectId().toString(),
        email,
        username: taken ? `support${Date.now().toString().slice(-4)}` : 'support',
        fullName: 'Findernate Support',
        password,
        role: 'admin',
        isActive: true,
        createdBy: null,
      });
      console.log('\nSuper admin created:', created.email, '(username', created.username + ')');
    }
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
