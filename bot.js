const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const multer = require('multer');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Express app setup
const app = express();
const port = process.env.PORT || 3000;

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = 'uploads';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir);
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + '-' + file.originalname);
  }
});
const upload = multer({ storage: storage });

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static('uploads'));

// WhatsApp client setup
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

// Owner number (replace with your number in international format)
const OWNER_NUMBER = '+94760761047'; // Example: '1234567890@c.us'

// Store allowed groups and users
const allowedGroups = new Set();
let isBotReady = false;

// Generate QR code for authentication
client.on('qr', (qr) => {
  console.log('QR RECEIVED', qr);
  qrcode.generate(qr, { small: true });
});

// When client is ready
client.on('ready', () => {
  console.log('Client is ready!');
  isBotReady = true;
  
  // Send ready message to owner
  client.sendMessage(OWNER_NUMBER, 'Bot is now online and ready!');
});

// When authentication fails
client.on('auth_failure', () => {
  console.log('Authentication failed');
  isBotReady = false;
});

// Handle incoming messages
client.on('message', async (message) => {
  // Ignore messages from status broadcasts
  if (message.from === 'status@broadcast') return;
  
  const chat = await message.getChat();
  const contact = await message.getContact();
  const isOwner = message.from === OWNER_NUMBER;
  const isGroup = chat.isGroup;
  const isAllowedGroup = allowedGroups.has(chat.id._serialized);
  
  // Only process commands from owner or allowed groups
  if (!isOwner && !isAllowedGroup) return;
  
  // Process commands
  if (message.body.startsWith('!')) {
    const command = message.body.split(' ')[0].substring(1).toLowerCase();
    const args = message.body.split(' ').slice(1);
    
    switch (command) {
      case 'help':
        await showHelp(message, isOwner);
        break;
      case 'addgroup':
        if (isOwner) await addGroup(message);
        break;
      case 'removegroup':
        if (isOwner) await removeGroup(message);
        break;
      case 'listgroups':
        if (isOwner) await listGroups(message);
        break;
      case 'download':
        await downloadFile(message, args);
        break;
      case 'upload':
        await uploadFile(message);
        break;
      case 'status':
        await showStatus(message, isOwner);
        break;
      default:
        await message.reply('Unknown command. Type !help for available commands.');
    }
  }
});

// Command functions
async function showHelp(message, isOwner) {
  let helpText = `*Bot Commands:*\n\n`;
  helpText += `*!download <url>* - Download file from URL\n`;
  helpText += `*!upload* - Reply to a file with this command to get a direct download link\n`;
  
  if (isOwner) {
    helpText += `\n*Owner Commands:*\n\n`;
    helpText += `*!addgroup* - Add current group to allowed list\n`;
    helpText += `*!removegroup* - Remove current group from allowed list\n`;
    helpText += `*!listgroups* - List all allowed groups\n`;
    helpText += `*!status* - Show bot status\n`;
  }
  
  await message.reply(helpText);
}

async function addGroup(message) {
  const chat = await message.getChat();
  if (chat.isGroup) {
    allowedGroups.add(chat.id._serialized);
    await message.reply('This group has been added to the allowed list.');
    
    // Save to file
    saveAllowedGroups();
  } else {
    await message.reply('This command can only be used in groups.');
  }
}

async function removeGroup(message) {
  const chat = await message.getChat();
  if (chat.isGroup) {
    allowedGroups.delete(chat.id._serialized);
    await message.reply('This group has been removed from the allowed list.');
    
    // Save to file
    saveAllowedGroups();
  } else {
    await message.reply('This command can only be used in groups.');
  }
}

async function listGroups(message) {
  if (allowedGroups.size === 0) {
    await message.reply('No groups are currently allowed.');
    return;
  }
  
  let groupList = '*Allowed Groups:*\n\n';
  for (const groupId of allowedGroups) {
    const chat = await client.getChatById(groupId);
    groupList += `- ${chat.name}\n`;
  }
  
  await message.reply(groupList);
}

async function downloadFile(message, args) {
  if (args.length === 0) {
    await message.reply('Please provide a URL. Usage: !download <url>');
    return;
  }
  
  const url = args[0];
  
  try {
    await message.reply('Downloading file...');
    
    // Download the file
    const response = await axios({
      method: 'GET',
      url: url,
      responseType: 'stream'
    });
    
    // Get filename from URL or content-disposition header
    let filename = url.split('/').pop();
    const contentDisposition = response.headers['content-disposition'];
    if (contentDisposition) {
      const filenameMatch = contentDisposition.match(/filename="?(.+)"?/);
      if (filenameMatch) filename = filenameMatch[1];
    }
    
    // Create temp directory if it doesn't exist
    const tempDir = 'temp';
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir);
    }
    
    const filePath = path.join(tempDir, filename);
    const writer = fs.createWriteStream(filePath);
    
    response.data.pipe(writer);
    
    writer.on('finish', async () => {
      try {
        const media = MessageMedia.fromFilePath(filePath);
        await client.sendMessage(message.from, media, {
          caption: `Here's your downloaded file: ${filename}`
        });
        
        // Clean up temp file
        fs.unlinkSync(filePath);
      } catch (error) {
        console.error('Error sending file:', error);
        await message.reply('Failed to send the file. It might be too large or in an unsupported format.');
        
        // Clean up temp file
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      }
    });
    
    writer.on('error', async (error) => {
      console.error('Error downloading file:', error);
      await message.reply('Failed to download the file. Please check the URL and try again.');
    });
  } catch (error) {
    console.error('Error downloading file:', error);
    await message.reply('Failed to download the file. Please check the URL and try again.');
  }
}

async function uploadFile(message) {
  if (!message.hasQuotedMsg) {
    await message.reply('Please reply to a file with this command to upload it.');
    return;
  }
  
  const quotedMsg = await message.getQuotedMessage();
  
  if (!quotedMsg.hasMedia) {
    await message.reply('The quoted message does not contain a file.');
    return;
  }
  
  try {
    await message.reply('Processing file...');
    
    const media = await quotedMsg.downloadMedia();
    
    if (!media) {
      await message.reply('Failed to download the file.');
      return;
    }
    
    // Generate a unique filename
    const extension = media.mimetype.split('/')[1];
    const filename = `file-${Date.now()}.${extension}`;
    const filePath = path.join('uploads', filename);
    
    // Save file to uploads directory
    const buffer = Buffer.from(media.data, 'base64');
    fs.writeFileSync(filePath, buffer);
    
    // Generate direct link (replace with your domain if hosted)
    const baseUrl = process.env.BASE_URL || `http://localhost:${port}`;
    const directLink = `${baseUrl}/uploads/${filename}`;
    
    await message.reply(`File uploaded successfully!\nDirect download link: ${directLink}`);
  } catch (error) {
    console.error('Error uploading file:', error);
    await message.reply('Failed to upload the file.');
  }
}

async function showStatus(message, isOwner) {
  if (!isOwner) return;
  
  const status = isBotReady ? 'Online' : 'Offline';
  let statusMessage = `*Bot Status:* ${status}\n\n`;
  statusMessage += `*Allowed Groups:* ${allowedGroups.size}\n`;
  
  await message.reply(statusMessage);
}

// Load allowed groups from file
function loadAllowedGroups() {
  try {
    if (fs.existsSync('allowed-groups.json')) {
      const data = fs.readFileSync('allowed-groups.json', 'utf8');
      const groups = JSON.parse(data);
      groups.forEach(group => allowedGroups.add(group));
    }
  } catch (error) {
    console.error('Error loading allowed groups:', error);
  }
}

// Save allowed groups to file
function saveAllowedGroups() {
  try {
    const groupsArray = Array.from(allowedGroups);
    fs.writeFileSync('allowed-groups.json', JSON.stringify(groupsArray));
  } catch (error) {
    console.error('Error saving allowed groups:', error);
  }
}

// Express routes
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head>
        <title>WhatsApp File Bot</title>
        <style>
          body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
          .status { padding: 10px; border-radius: 5px; margin: 10px 0; }
          .online { background-color: #d4edda; color: #155724; }
          .offline { background-color: #f8d7da; color: #721c24; }
        </style>
      </head>
      <body>
        <h1>WhatsApp File Bot</h1>
        <div class="status ${isBotReady ? 'online' : 'offline'}">
          Status: ${isBotReady ? 'Online' : 'Offline'}
        </div>
        <p>This bot allows file downloads and uploads with direct links through WhatsApp.</p>
        <h2>Usage:</h2>
        <ul>
          <li>Send <code>!help</code> to the bot to see available commands</li>
          <li>Use <code>!download &lt;url&gt;</code> to download a file from a URL</li>
          <li>Reply to a file with <code>!upload</code> to get a direct download link</li>
        </ul>
        <h2>Owner Commands:</h2>
        <ul>
          <li><code>!addgroup</code> - Add current group to allowed list</li>
          <li><code>!removegroup</code> - Remove current group from allowed list</li>
          <li><code>!listgroups</code> - List all allowed groups</li>
          <li><code>!status</code> - Show bot status</li>
        </ul>
      </body>
    </html>
  `);
});

// Start the server and bot
app.listen(port, () => {
  console.log(`Web server running on port ${port}`);
  loadAllowedGroups();
  client.initialize();
});

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down...');
  saveAllowedGroups();
  process.exit(0);
});
