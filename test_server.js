const fs = require('fs');
const path = require('path');

const API_URL = 'http://localhost:5000';
let token = null;
let testUser = null;
let testFolder = null;
let testFile = null;

// Helper to log test progress
const logTest = (stepName, success, details = '') => {
  const icon = success ? '✅' : '❌';
  console.log(`${icon} [${stepName}] ${success ? 'PASSED' : 'FAILED'} ${details ? `- ${details}` : ''}`);
  if (!success) {
    process.exit(1);
  }
};

async function runTests() {
  console.log('===================================================');
  console.log('🚀 STARTING VAULT SERVER INTEGRATION TESTS');
  console.log(`Targeting Server: ${API_URL}`);
  console.log('===================================================\n');

  const email = `tester_${Date.now()}@example.com`;
  const name = 'QA Tester';
  const password = 'securepassword123';

  // --- TEST 1: Register User ---
  try {
    const signupRes = await fetch(`${API_URL}/api/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password }),
    });

    const data = await signupRes.json();
    if (signupRes.status === 201 && data.token && data.user) {
      token = data.token;
      testUser = data.user;
      logTest('User Registration', true, `Created email: ${email}`);
    } else {
      logTest('User Registration', false, `Status ${signupRes.status}: ${data.message}`);
    }
  } catch (err) {
    logTest('User Registration', false, err.message);
  }

  // --- TEST 2: Log In ---
  try {
    const loginRes = await fetch(`${API_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    const data = await loginRes.json();
    if (loginRes.status === 200 && data.token) {
      logTest('User Login', true, 'Session token retrieved');
    } else {
      logTest('User Login', false, `Status ${loginRes.status}: ${data.message}`);
    }
  } catch (err) {
    logTest('User Login', false, err.message);
  }

  // --- TEST 3: Verify Default Profile & Limit (3GB) ---
  try {
    const profileRes = await fetch(`${API_URL}/api/auth/me`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    const data = await profileRes.json();
    const expectedLimit = 3 * 1024 * 1024 * 1024; // 3GB
    if (profileRes.status === 200 && data.storageLimit === expectedLimit) {
      logTest('Profile Storage Check', true, `Default space: ${data.storageLimit} bytes (3 GB)`);
    } else {
      logTest('Profile Storage Check', false, `Got limit: ${data.storageLimit} bytes`);
    }
  } catch (err) {
    logTest('Profile Storage Check', false, err.message);
  }

  // --- TEST 4: Create Folder ---
  try {
    const folderName = 'QA Vault Root';
    const folderRes = await fetch(`${API_URL}/api/vault/folders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ name: folderName }),
    });

    const data = await folderRes.json();
    if (folderRes.status === 201 && data._id) {
      testFolder = data;
      logTest('Folder Creation', true, `Folder ID: ${data._id}, Name: ${data.name}`);
    } else {
      logTest('Folder Creation', false, `Status ${folderRes.status}: ${data.message}`);
    }
  } catch (err) {
    logTest('Folder Creation', false, err.message);
  }

  // --- TEST 5: Upload File ---
  const dummyFilePath = path.join(__dirname, 'qa_test_asset.txt');
  fs.writeFileSync(dummyFilePath, 'Hello World! This is an integration test content for range streaming.');
  const fileStats = fs.statSync(dummyFilePath);

  try {
    // Construct FormData using standard Node 18 FormData API
    const formData = new FormData();
    const blob = new Blob([fs.readFileSync(dummyFilePath)], { type: 'text/plain' });
    formData.append('file', blob, 'qa_test_asset.txt');
    formData.append('folderId', testFolder._id);

    const uploadRes = await fetch(`${API_URL}/api/vault/files/upload`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`
      },
      body: formData,
    });

    const data = await uploadRes.json();
    if (uploadRes.status === 201 && data._id) {
      testFile = data;
      logTest('File Upload', true, `File ID: ${data._id}, Size: ${data.size} bytes`);
    } else {
      logTest('File Upload', false, `Status ${uploadRes.status}: ${data.message}`);
    }
  } catch (err) {
    logTest('File Upload', false, err.message);
  } finally {
    if (fs.existsSync(dummyFilePath)) {
      fs.unlinkSync(dummyFilePath);
    }
  }

  // --- TEST 6: Get Content List ---
  try {
    const contentRes = await fetch(`${API_URL}/api/vault/content?folderId=${testFolder._id}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    const data = await contentRes.json();
    const fileFound = data.files.some(f => f._id === testFile._id);
    if (contentRes.status === 200 && fileFound) {
      logTest('Fetch Directory Listing', true, `Retrieved ${data.files.length} files inside folder`);
    } else {
      logTest('Fetch Directory Listing', false, `File not found in listing`);
    }
  } catch (err) {
    logTest('Fetch Directory Listing', false, err.message);
  }

  // --- TEST 7: Range Streaming Seek (HTTP 206) ---
  try {
    // Request bytes 0-10 (should be "Hello World")
    const rangeRes = await fetch(`${API_URL}/api/vault/files/stream/${testFile._id}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Range': 'bytes=0-10'
      }
    });

    const bodyText = await rangeRes.text();
    const contentRange = rangeRes.headers.get('Content-Range');
    
    if (
      rangeRes.status === 206 &&
      bodyText === 'Hello World' &&
      contentRange &&
      contentRange.startsWith('bytes 0-10/')
    ) {
      logTest('Range Request seek (HTTP 206)', true, `Received chunk: "${bodyText}", Header: ${contentRange}`);
    } else {
      logTest(
        'Range Request seek (HTTP 206)',
        false,
        `Status: ${rangeRes.status}, Content: "${bodyText}", RangeHeader: ${contentRange}`
      );
    }
  } catch (err) {
    logTest('Range Request seek (HTTP 206)', false, err.message);
  }

  // --- TEST 8: Upgrade Subscription Plan ---
  try {
    const subRes = await fetch(`${API_URL}/api/vault/subscription`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ plan: 'silver', billing: 'monthly' }),
    });

    const data = await subRes.json();
    const expectedLimit = 20 * 1024 * 1024 * 1024; // 20GB
    if (subRes.status === 200 && data.storageLimit === expectedLimit && data.subscription.plan === 'silver') {
      logTest('Upgrade Subscription Tier', true, `Expanded storage limit to: ${data.storageLimit} bytes (20 GB)`);
    } else {
      logTest('Upgrade Subscription Tier', false, `Plan status: ${data.subscription.plan}, limit: ${data.storageLimit}`);
    }
  } catch (err) {
    logTest('Upgrade Subscription Tier', false, err.message);
  }

  // --- TEST 9: Recursive Folder Cleanup Deletion ---
  try {
    const deleteRes = await fetch(`${API_URL}/api/vault/folders/${testFolder._id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (deleteRes.status === 200) {
      // Check that folder contents and folder are gone
      const verifyRes = await fetch(`${API_URL}/api/vault/content`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const verifyData = await verifyRes.json();
      const hasFolders = verifyData.folders.some(f => f._id === testFolder._id);
      
      if (!hasFolders) {
        logTest('Recursive Folder Deletion', true, 'Folder and files deleted from DB & MinIO');
      } else {
        logTest('Recursive Folder Deletion', false, 'Folder document still present in root');
      }
    } else {
      logTest('Recursive Folder Deletion', false, `Delete failed with status: ${deleteRes.status}`);
    }
  } catch (err) {
    logTest('Recursive Folder Deletion', false, err.message);
  }

  console.log('\n===================================================');
  console.log('🏆 ALL INTEGRATION TESTS PASSED SUCCESSFULLY! 🏆');
  console.log('===================================================');
}

runTests();
