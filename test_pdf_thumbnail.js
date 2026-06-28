const fs = require('fs');
const path = require('path');

const API_URL = 'http://localhost:5000';
let token = null;

const logTest = (stepName, success, details = '') => {
  const icon = success ? '✅' : '❌';
  console.log(`${icon} [${stepName}] ${success ? 'PASSED' : 'FAILED'} ${details ? `- ${details}` : ''}`);
  if (!success) {
    process.exit(1);
  }
};

const MINIMAL_PDF = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> /Contents 4 0 R >>
endobj
4 0 obj
<< /Length 44 >>
stream
BT /F1 12 Tf 70 700 Td (Hello PDF World) Tj ET
endstream
endobj
xref
0 5
0000000000 65535 f 
0000000009 00000 n 
0000000056 00000 n 
0000000111 00000 n 
0000000236 00000 n 
trailer
<< /Size 5 /Root 1 0 R >>
startxref
330
%%EOF`;

async function testPdfThumbnail() {
  console.log('===================================================');
  console.log('🚀 TESTING PDF UPLOAD & THUMBNAIL GENERATION');
  console.log('===================================================\n');

  const email = `pdf_test_${Date.now()}@example.com`;
  const name = 'PDF Tester';
  const password = 'securepassword123';

  // 1. Signup
  try {
    const signupRes = await fetch(`${API_URL}/api/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password }),
    });
    const data = await signupRes.json();
    token = data.token;
    logTest('Register User', signupRes.status === 201 && token, `Email: ${email}`);
  } catch (err) {
    logTest('Register User', false, err.message);
  }

  // 2. Write and upload PDF
  const pdfPath = path.join(__dirname, 'test_doc.pdf');
  fs.writeFileSync(pdfPath, MINIMAL_PDF);

  let uploadedFile = null;
  try {
    const formData = new FormData();
    const blob = new Blob([fs.readFileSync(pdfPath)], { type: 'application/pdf' });
    formData.append('file', blob, 'test_doc.pdf');

    const uploadRes = await fetch(`${API_URL}/api/vault/files/upload`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: formData,
    });

    uploadedFile = await uploadRes.json();
    logTest('Upload PDF File', uploadRes.status === 201 && uploadedFile._id, `File ID: ${uploadedFile._id}, ThumbnailKey: ${uploadedFile.thumbnailKey}`);
  } catch (err) {
    logTest('Upload PDF File', false, err.message);
  } finally {
    if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);
  }

  // 3. Verify Thumbnail Key and fetch thumbnail stream
  if (!uploadedFile.thumbnailKey) {
    logTest('Thumbnail Key Check', false, 'Server did not return a thumbnailKey in file object.');
  } else {
    logTest('Thumbnail Key Check', true, `Key: ${uploadedFile.thumbnailKey}`);
  }

  try {
    const thumbRes = await fetch(`${API_URL}/api/vault/files/thumbnail/${uploadedFile._id}?token=${token}`);
    if (thumbRes.status === 200 && thumbRes.headers.get('Content-Type') === 'image/png') {
      const buffer = await thumbRes.arrayBuffer();
      logTest('Stream PDF Thumbnail PNG', buffer.byteLength > 0, `Length: ${buffer.byteLength} bytes`);
    } else {
      logTest('Stream PDF Thumbnail PNG', false, `Status ${thumbRes.status}, Content-Type: ${thumbRes.headers.get('Content-Type')}`);
    }
  } catch (err) {
    logTest('Stream PDF Thumbnail PNG', false, err.message);
  }

  // 4. Delete PDF & Check cleanup
  try {
    const delRes = await fetch(`${API_URL}/api/vault/files/${uploadedFile._id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    logTest('Delete PDF File', delRes.status === 200, 'File deleted successfully.');
  } catch (err) {
    logTest('Delete PDF File', false, err.message);
  }

  console.log('\n===================================================');
  console.log('🏆 PDF THUMBNAIL INTEGRATION TESTS PASSED! 🏆');
  console.log('===================================================');
}

testPdfThumbnail().catch(err => {
  console.error(err);
  process.exit(1);
});
