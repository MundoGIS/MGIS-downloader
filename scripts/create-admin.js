const readline = require('readline');
const { createInitialAdmin } = require('../auth');

if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    console.error('Run this command in an interactive terminal.');
    process.exit(1);
}

const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
prompt.question('Admin username: ', username => {
    prompt.close();
    process.stdout.write('Password (12+ characters, hidden): ');
    let password = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    function onKey(key) {
        if (key === '\u0003') process.exit(1);
        if (key === '\r' || key === '\n') {
            process.stdin.setRawMode(false);
            process.stdin.removeListener('data', onKey);
            process.stdout.write('\n');
            try {
                const user = createInitialAdmin(username.trim(), password);
                console.log(`Created admin: ${user.username}`);
            } catch (error) {
                console.error(error.message);
                process.exitCode = 1;
            }
            password = '';
            process.stdin.pause();
        } else if (key === '\u007f' || key === '\b') {
            password = password.slice(0, -1);
        } else if (key.length === 1) {
            password += key;
        }
    }
    process.stdin.on('data', onKey);
});