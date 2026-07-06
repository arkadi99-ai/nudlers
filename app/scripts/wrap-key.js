import crypto from 'crypto';
import process from 'process';

/**
 * Utility to wrap a master key with a passphrase.
 * Usage: node scripts/wrap-key.js <hex-master-key|new> <passphrase>
 */

const USAGE = 'Usage: node scripts/wrap-key.js <hex-master-key|new> <passphrase>\n  Use "new" to generate a fresh 32-byte master key.';

let masterKey;
let masterKeyHex = process.argv[2];
const passphrase = process.argv[3];
const salt = 'nudlers-vault-salt';

if (!masterKeyHex || !passphrase) {
    console.error(USAGE);
    process.exit(1);
}

const isNew = masterKeyHex.toLowerCase() === 'new';
if (isNew) {
    masterKey = crypto.randomBytes(32);
} else {
    masterKey = Buffer.from(masterKeyHex, 'hex');
    if (masterKey.length !== 32) {
        console.error('Error: master key must be 32 bytes (64 hex characters).');
        console.error(USAGE);
        process.exit(1);
    }
}


const wrappingKey = crypto.scryptSync(passphrase, salt, 32);
const iv = crypto.randomBytes(12);
const cipher = crypto.createCipheriv('aes-256-gcm', wrappingKey, iv);

let wrapped = cipher.update(masterKey);
wrapped = Buffer.concat([wrapped, cipher.final()]);
const authTag = cipher.getAuthTag();

const wrappedMasterKeyStr = `${iv.toString('hex')}:${wrapped.toString('hex')}:${authTag.toString('hex')}`;

if (isNew) {
    console.log(`Master key (hex): ${masterKey.toString('hex')}`);
}
console.log(`Wrapped master key: ${wrappedMasterKeyStr}`);
