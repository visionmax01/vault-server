const fs = require('fs');
const path = require('path');

const API_URL = 'http://localhost:5000';
let token = null;
let testUser = null;

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
  console.log('🚀 STARTING RENAME AND MOVE INTEGRATION TESTS');
  console.log(`Targeting Server: ${API_URL}`);
  console.log('===================================================\n');

  const email = `test_rm_${Date.now()}@example.com`;
  const name = 'Rename Move Tester';
  const password = 'securepassword123';

  // 1. Signup
  try {
    const signupRes = await fetch(`${API_URL}/api/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password }),
    });
    const data = await signupRes.json();
    if (signupRes.status === 201 && data.token) {
      token = data.token;
      testUser = data.user;
      logTest('Signup', true, `Created email: ${email}`);
    } else {
      logTest('Signup', false, `Status ${signupRes.status}: ${data.message}`);
    }
  } catch (err) {
    logTest('Signup', false, err.message);
  }

  // 2. Create Folder A and Folder B at root level
  let folderA, folderB;
  try {
    const resA = await fetch(`${API_URL}/api/vault/folders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ name: 'Folder A' }),
    });
    folderA = await resA.json();
    logTest('Create Folder A', resA.status === 201 && folderA._id, `ID: ${folderA._id}`);

    const resB = await fetch(`${API_URL}/api/vault/folders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ name: 'Folder B' }),
    });
    folderB = await resB.json();
    logTest('Create Folder B', resB.status === 201 && folderB._id, `ID: ${folderB._id}`);
  } catch (err) {
    logTest('Folder Creation A/B', false, err.message);
  }

  // 3. Create Folder C inside Folder A
  let folderC;
  try {
    const resC = await fetch(`${API_URL}/api/vault/folders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ name: 'Folder C', parentFolderId: folderA._id }),
    });
    folderC = await resC.json();
    logTest('Create Folder C inside Folder A', resC.status === 201 && folderC._id, `ID: ${folderC._id}`);
  } catch (err) {
    logTest('Folder Creation C', false, err.message);
  }

  // 4. Try to move Folder A into Folder A (should fail)
  try {
    const moveRes = await fetch(`${API_URL}/api/vault/folders/${folderA._id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ parentFolderId: folderA._id }),
    });
    const data = await moveRes.json();
    if (moveRes.status === 400) {
      logTest('Prevent moving a folder into itself', true, `Expected error: ${data.message}`);
    } else {
      logTest('Prevent moving a folder into itself', false, `Status ${moveRes.status}: ${data.message}`);
    }
  } catch (err) {
    logTest('Prevent moving a folder into itself', false, err.message);
  }

  // 5. Try to move Folder A into Folder C (its own subfolder, should fail)
  try {
    const moveRes = await fetch(`${API_URL}/api/vault/folders/${folderA._id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ parentFolderId: folderC._id }),
    });
    const data = await moveRes.json();
    if (moveRes.status === 400) {
      logTest('Prevent moving a folder into its subfolder', true, `Expected error: ${data.message}`);
    } else {
      logTest('Prevent moving a folder into its subfolder', false, `Status ${moveRes.status}: ${data.message}`);
    }
  } catch (err) {
    logTest('Prevent moving a folder into its subfolder', false, err.message);
  }

  // 6. Rename Folder A to "Folder A Renamed" (should succeed)
  try {
    const renameRes = await fetch(`${API_URL}/api/vault/folders/${folderA._id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ name: 'Folder A Renamed' }),
    });
    const data = await renameRes.json();
    if (renameRes.status === 200 && data.name === 'Folder A Renamed') {
      logTest('Rename folder', true, `New name: ${data.name}`);
    } else {
      logTest('Rename folder', false, `Status ${renameRes.status}: ${data.message}`);
    }
  } catch (err) {
    logTest('Rename folder', false, err.message);
  }

  // 7. Try to rename Folder B to "Folder A Renamed" (duplicate at same parent, should fail)
  try {
    const renameRes = await fetch(`${API_URL}/api/vault/folders/${folderB._id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ name: 'Folder A Renamed' }),
    });
    const data = await renameRes.json();
    if (renameRes.status === 400) {
      logTest('Prevent duplicate name in same parent folder', true, `Expected error: ${data.message}`);
    } else {
      logTest('Prevent duplicate name in same parent folder', false, `Status ${renameRes.status}: ${data.message}`);
    }
  } catch (err) {
    logTest('Prevent duplicate name in same parent folder', false, err.message);
  }

  // 8. Upload a file inside Folder A (Renamed)
  let testFile;
  const tempFile = path.join(__dirname, 'rm_test.txt');
  fs.writeFileSync(tempFile, 'Test file for rename and move operations.');
  try {
    const formData = new FormData();
    const blob = new Blob([fs.readFileSync(tempFile)], { type: 'text/plain' });
    formData.append('file', blob, 'rm_test.txt');
    formData.append('folderId', folderA._id);

    const uploadRes = await fetch(`${API_URL}/api/vault/files/upload`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: formData,
    });
    testFile = await uploadRes.json();
    logTest('Upload file to Folder A', uploadRes.status === 201 && testFile._id, `File ID: ${testFile._id}`);
  } catch (err) {
    logTest('Upload file to Folder A', false, err.message);
  } finally {
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
  }

  // 8.5. Try to upload the same file again inside Folder A (should fail with 400 now)
  const tempFile2 = path.join(__dirname, 'rm_test.txt');
  fs.writeFileSync(tempFile2, 'Test file for duplicate upload block.');
  try {
    const formData = new FormData();
    const blob = new Blob([fs.readFileSync(tempFile2)], { type: 'text/plain' });
    formData.append('file', blob, 'rm_test.txt');
    formData.append('folderId', folderA._id);

    const uploadRes = await fetch(`${API_URL}/api/vault/files/upload`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: formData,
    });
    const uploadResJson = await uploadRes.json();
    if (uploadRes.status === 400) {
      logTest('Prevent duplicate file upload inside same folder', true, `Expected error: ${uploadResJson.message}`);
    } else {
      logTest('Prevent duplicate file upload inside same folder', false, `Status ${uploadRes.status}: ${uploadResJson.message}`);
    }
  } catch (err) {
    logTest('Prevent duplicate file upload inside same folder', false, err.message);
  } finally {
    if (fs.existsSync(tempFile2)) fs.unlinkSync(tempFile2);
  }

  // 9. Move file to Folder C
  try {
    const moveRes = await fetch(`${API_URL}/api/vault/files/${testFile._id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ folderId: folderC._id }),
    });
    const data = await moveRes.json();
    if (moveRes.status === 200 && data.folder === folderC._id) {
      logTest('Move file to another folder', true, `Target folder: ${data.folder}`);
    } else {
      logTest('Move file to another folder', false, `Status ${moveRes.status}: ${data.message}`);
    }
  } catch (err) {
    logTest('Move file to another folder', false, err.message);
  }

  // 10. Rename file
  try {
    const renameRes = await fetch(`${API_URL}/api/vault/files/${testFile._id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ name: 'rm_test_renamed.txt' }),
    });
    const data = await renameRes.json();
    if (renameRes.status === 200 && data.name === 'rm_test_renamed.txt') {
      logTest('Rename file', true, `New name: ${data.name}`);
    } else {
      logTest('Rename file', false, `Status ${renameRes.status}: ${data.message}`);
    }
  } catch (err) {
    logTest('Rename file', false, err.message);
  }

  // 11. Move Folder C into Folder B
  try {
    const moveRes = await fetch(`${API_URL}/api/vault/folders/${folderC._id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ parentFolderId: folderB._id }),
    });
    const data = await moveRes.json();
    if (moveRes.status === 200 && data.parentFolder === folderB._id) {
      logTest('Move folder to another folder', true, `Target parent: ${data.parentFolder}`);
    } else {
      logTest('Move folder to another folder', false, `Status ${moveRes.status}: ${data.message}`);
    }
  } catch (err) {
    logTest('Move folder to another folder', false, err.message);
  }

  // 12. Cleanup
  try {
    const delResA = await fetch(`${API_URL}/api/vault/folders/${folderA._id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const delResB = await fetch(`${API_URL}/api/vault/folders/${folderB._id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    logTest('Cleanup deleted folders A & B', delResA.status === 200 && delResB.status === 200, 'All test documents purged.');
  } catch (err) {
    logTest('Cleanup', false, err.message);
  }

  console.log('\n===================================================');
  console.log('🏆 ALL RENAME AND MOVE TESTS PASSED SUCCESSFULLY! 🏆');
  console.log('===================================================');
}

runTests().catch(err => {
  console.error('Test suite runner crashed:', err);
  process.exit(1);
});
