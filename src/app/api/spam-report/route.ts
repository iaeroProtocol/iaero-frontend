// ==============================================
// src/app/api/spam-report/route.ts
// ==============================================
// API endpoint to report newly-discovered spam tokens
// These get appended to the GitHub-hosted blocklist
//
// Requires environment variable:
//   GITHUB_SPAM_TOKEN - Personal Access Token with repo write access
//
import { NextRequest, NextResponse } from 'next/server';

const GITHUB_OWNER = 'iaeroProtocol';
const GITHUB_REPO = 'ChainProcessingBot';
const GITHUB_PATH = 'data/spam_tokens_base.json';
const GITHUB_BRANCH = 'main';

interface SpamReport {
  address: string;
  symbol: string;
  reason: string;
  reportedBy?: string;
  chainId?: number;
}

export async function POST(request: NextRequest) {
  try {
    const token = process.env.GITHUB_SPAM_TOKEN;
    
    if (!token) {
      console.warn('GITHUB_SPAM_TOKEN not configured - spam reports will be logged only');
      const body = await request.json();
      console.log('📋 Spam token reported (not persisted):', body);
      return NextResponse.json({ 
        success: true, 
        persisted: false,
        message: 'Logged but not persisted (GitHub token not configured)' 
      });
    }

    const reports: SpamReport[] = await request.json();
    
    if (!Array.isArray(reports) || reports.length === 0) {
      return NextResponse.json({ error: 'Expected array of spam reports' }, { status: 400 });
    }

    // Validate each report
    for (const report of reports) {
      if (!report.address || !report.symbol) {
        return NextResponse.json({ error: 'Each report must have address and symbol' }, { status: 400 });
      }
      // Normalize address
      report.address = report.address.toLowerCase();
    }

    // 1. Fetch current file from GitHub
    const fileUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_PATH}?ref=${GITHUB_BRANCH}`;
    
    const fileRes = await fetch(fileUrl, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    });

    let currentData: { tokens: any[]; symbolPatterns: string[] } = { tokens: [], symbolPatterns: [] };
    let sha: string | undefined;

    if (fileRes.ok) {
      const fileJson = await fileRes.json();
      sha = fileJson.sha;
      const content = Buffer.from(fileJson.content, 'base64').toString('utf-8');
      currentData = JSON.parse(content);
    } else if (fileRes.status !== 404) {
      console.error('GitHub API error:', await fileRes.text());
      return NextResponse.json({ error: 'Failed to fetch current blocklist' }, { status: 500 });
    }

    // 2. Check for duplicates and add new entries
    const existingAddresses = new Set(currentData.tokens.map((t: any) => t.address.toLowerCase()));
    const newTokens: any[] = [];
    const duplicates: string[] = [];

    for (const report of reports) {
      if (existingAddresses.has(report.address)) {
        duplicates.push(report.symbol);
      } else {
        newTokens.push({
          address: report.address,
          symbol: report.symbol,
          reason: report.reason || 'Auto-detected spam',
          addedAt: new Date().toISOString(),
          reportedBy: report.reportedBy || 'auto'
        });
        existingAddresses.add(report.address);
      }
    }

    if (newTokens.length === 0) {
      return NextResponse.json({ 
        success: true, 
        added: 0,
        duplicates: duplicates.length,
        message: 'All reported tokens already in blocklist'
      });
    }

    // 3. Update the data
    currentData.tokens.push(...newTokens);

    // 4. Push to GitHub
    const newContent = Buffer.from(JSON.stringify(currentData, null, 2)).toString('base64');
    
    const updateRes = await fetch(fileUrl, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: `Add ${newTokens.length} spam token(s): ${newTokens.map(t => t.symbol).join(', ')}`,
        content: newContent,
        sha: sha,
        branch: GITHUB_BRANCH
      })
    });

    if (!updateRes.ok) {
      const errText = await updateRes.text();
      console.error('GitHub update failed:', errText);
      return NextResponse.json({ error: 'Failed to update blocklist' }, { status: 500 });
    }

    console.log(`✅ Added ${newTokens.length} spam tokens to blocklist:`, newTokens.map(t => t.symbol));

    return NextResponse.json({ 
      success: true, 
      persisted: true,
      added: newTokens.length,
      duplicates: duplicates.length,
      tokens: newTokens.map(t => t.symbol)
    });

  } catch (e: any) {
    console.error('Spam report error:', e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// GET endpoint to check current blocklist stats
export async function GET() {
  try {
    const token = process.env.GITHUB_SPAM_TOKEN;
    const fileUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_PATH}?ref=${GITHUB_BRANCH}`;
    
    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github.v3+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };
    
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const res = await fetch(fileUrl, { headers });
    
    if (!res.ok) {
      return NextResponse.json({ 
        configured: !!token,
        tokenCount: 0,
        patternCount: 0
      });
    }

    const fileJson = await res.json();
    const content = Buffer.from(fileJson.content, 'base64').toString('utf-8');
    const data = JSON.parse(content);

    return NextResponse.json({
      configured: !!token,
      tokenCount: data.tokens?.length || 0,
      patternCount: data.symbolPatterns?.length || 0,
      lastUpdated: fileJson.sha?.substring(0, 7)
    });
  } catch (e) {
    return NextResponse.json({ configured: false, error: 'Failed to fetch stats' });
  }
}