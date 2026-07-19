const Folder = require('../models/Folder');
const File = require('../models/File');
const vaultController = require('../controllers/vaultController');

const CLEANUP_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours
const EXPIRATION_DAYS = 20;

const runTrashCleanup = async () => {
  try {
    console.log('[Trash Worker] Scanning for expired trash items...');
    
    // Calculate date threshold (20 days ago)
    const thresholdDate = new Date(Date.now() - EXPIRATION_DAYS * 24 * 60 * 60 * 1000);
    
    // Find all explicitly deleted top-level folders and files that are expired
    const expiredFolders = await Folder.find({
      isDeleted: true,
      deletedParent: null,
      deletedAt: { $lte: thresholdDate }
    });

    const expiredFiles = await File.find({
      isDeleted: true,
      deletedParent: null,
      deletedAt: { $lte: thresholdDate }
    });

    if (expiredFolders.length > 0 || expiredFiles.length > 0) {
      console.log(`[Trash Worker] Found ${expiredFolders.length} expired folders and ${expiredFiles.length} expired files.`);
    }

    // Delete expired folders
    for (const folder of expiredFolders) {
      console.log(`[Trash Worker] Auto-deleting folder "${folder.name}" (${folder._id})`);
      await vaultController.permanentlyDeleteFolderHelper(folder._id, folder.owner);
    }

    // Delete expired files
    for (const file of expiredFiles) {
      console.log(`[Trash Worker] Auto-deleting file "${file.name}" (${file._id})`);
      await vaultController.permanentlyDeleteFileHelper(file._id, file.owner);
    }

    if (expiredFolders.length > 0 || expiredFiles.length > 0) {
      console.log('[Trash Worker] Trash cleanup completed successfully.');
    }
  } catch (error) {
    console.error('[Trash Worker] Error executing trash auto-cleanup:', error);
  }
};

const initTrashWorker = () => {
  console.log('[Trash Worker] Initializing 20-day automatic trash cleanup schedule (Runs every 24h)...');
  
  // Run immediately on boot (wait 10 seconds for MongoDB connection to initialize fully)
  setTimeout(runTrashCleanup, 10000);
  
  // Schedule to run periodically
  setInterval(runTrashCleanup, CLEANUP_INTERVAL);
};

module.exports = {
  initTrashWorker
};
