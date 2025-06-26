/**
 * ULK MIS Marks Scraper with Enhanced Session Management, Dynamic Loading Wait,
 * and Direct Prisma Database Saving, converted to ES Module (ESM) syntax.
 *
 * This version fixes session expiration and authentication issues,
 * waits for marks data to load dynamically, prioritizes correct mark extraction,
 * AND saves directly to the Prisma database using the Marksheet model.
 *
 * FIX: Addressed DOMException for invalid ':is()' and ':contains()' selectors.
 * FIX: Addressed 'No element found for selector: #txtUserName' by adding a waitForSelector.
 * FIX: Improved checkSessionValidity to correctly identify logged-in dashboard page.
 * NEW: Added fallback for student_uuid in saveMarksDataToPrisma.
 */

import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { PrismaClient } from '../src/generated/prisma/client.js'; // Adjust the path as necessary
import dotenv from 'dotenv';
import { fileURLToPath } from 'url'; // Required for __dirname equivalent in ESM
import { dirname } from 'path'; // Required for __dirname equivalent in ESM

// Get __dirname equivalent in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config(); // Load environment variables from .env file

// Initialize Prisma Client
const prisma = new PrismaClient({
    datasources: {
        db: {
            url: process.env.DATABASE_URL, // Ensure DATABASE_URL is set in your .env
        },
    },
});

// Import configurations (assuming these config files will also be ESM or handle mixed imports)
// If config/credentials.js and config/settings.js are still CommonJS, you might need dynamic import:
// const credentials = (await import('../config/credentials.js')).default;
// const settings = (await import('../config/settings.js')).default;
// For simplicity, assuming they are or will be converted to ESM and export default.
import credentials from '../config/credentials.js';
import settings from '../config/settings.js';

// Paths for cookie storage
const COOKIES_PATH = path.join(settings.dataDir, 'cookies.json');

// Helper function to safely delay execution
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Helper function to ensure a directory exists
const ensureDirExists = dirPath => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
};

// Ensure data and screenshots directories exist
ensureDirExists(settings.dataDir);
ensureDirExists(settings.screenshotsDir);

/**
 * Takes a screenshot and saves it to the screenshots directory
 */
async function takeScreenshot(page, name) {
  try {
    const filename = path.join(settings.screenshotsDir, `${name}.png`);
    await page.screenshot({ path: filename, fullPage: true });
    console.log(`Screenshot saved: ${filename}`);
    return filename;
  } catch (error) {
    console.log(`Failed to take screenshot: ${error.message}`);
    return null;
  }
}

/**
 * Check if current page is login page
 * Now more robust, checking for successful login indicators.
 */
async function isLoginPage(page) {
  try {
    const url = page.url();
    const title = await page.title();
    
    // Primary check: URL or title contains 'login' or is default.aspx
    const isLoginUrlOrTitle = url.toLowerCase().includes('login') || 
                              title.toLowerCase().includes('login') ||
                              url.toLowerCase().includes('default.aspx');
    
    // Check for presence of login form elements
    const hasLoginFormElements = await page.$('#txtUserName') !== null && await page.$('#txtPassword') !== null;
    
    // Check for absence of typical post-login elements (e.g., dashboard links)
    // **IMPORTANT: CUSTOMIZE THESE SELECTORS FOR YOUR ULK MIS DASHBOARD/POST-LOGIN PAGE**
    // Add specific selectors that ONLY appear when successfully logged in (e.g., your student ID, welcome message)
    const hasPostLoginIndicator = await page.$('a[href*="Logout.aspx"]') !== null || // Common logout link
                                   await page.$('#ctl00_lblWelcomeMessage') !== null || // Common ASP.NET welcome message label ID
                                   await page.$('#ctl00_ContentPlaceHolder1_StudentNameLabel') !== null || // Example of a student name label on dashboard
                                   await page.$('a[href*="Marksheet.aspx"]') !== null || // A link to the marksheet from dashboard
                                   url.toLowerCase().includes('dashboard'); // If the URL itself is dashboard

    const actualIsLoginPage = (isLoginUrlOrTitle && hasLoginFormElements) || // Definitely login page (has login elements and URL/title matches)
                              (!hasPostLoginIndicator && !url.toLowerCase().includes('marksheet') && !url.toLowerCase().includes('dashboard')); // Not login, but no positive login indicators either, and not on marksheet/dashboard

    console.log(`Page check - URL: ${url}, Title: ${title}, Is Login: ${actualIsLoginPage}`);
    return actualIsLoginPage;
  } catch (error) {
    console.log('Error checking if login page:', error.message);
    return false;
  }
}

/**
 * Enhanced login function with better session handling
 */
async function performLogin(page) {
  console.log('=== PERFORMING LOGIN ===');
  
  console.log('Navigating to login page:', settings.loginUrl);
  await page.goto(settings.loginUrl, { waitUntil: 'domcontentloaded', timeout: settings.navigationTimeoutMs });
  
  await delay(settings.pageLoadWaitMs); // Give it a moment after initial load

  const currentUrlAfterGoto = page.url();
  const currentPageTitleAfterGoto = await page.title();
  console.log(`Current URL after goto: ${currentUrlAfterGoto}`);
  console.log(`Current page title after goto: ${currentPageTitleAfterGoto}`);

  // Add a robust wait for the username field to appear
  console.log('Waiting for username field (#txtUserName) to be visible...');
  try {
    await page.waitForSelector('#txtUserName', { visible: true, timeout: 15000 }); // Increased timeout
    console.log('Username field (#txtUserName) is visible.');
  } catch (error) {
    console.error('❌ Username field (#txtUserName) not found or not visible after navigation to login URL:', error.message);
    await takeScreenshot(page, 'login_page_no_username_field');
    // Check if it redirected to home page
    if (currentUrlAfterGoto.includes('Home.aspx') || currentUrlAfterGoto === settings.dashboardUrl) {
      console.log('It appears we were redirected to the home/dashboard page. Session might be implicitly valid or not requiring direct login.');
      return 'already_logged_in_or_redirected'; // New return state
    }
    return 'login_page_element_missing'; // Indicate failure
  }
  
  await takeScreenshot(page, 'login_page_ready_for_input');
  
  console.log('Filling in credentials...');
  await page.evaluate(() => {
    const userField = document.querySelector('#txtUserName');
    const passField = document.querySelector('#txtPassword');
    if (userField) userField.value = '';
    if (passField) passField.value = '';
  });
  
  await page.type('#txtUserName', credentials.username, { delay: 50 });
  await page.type('#txtPassword', credentials.password, { delay: 50 });
  
  const captchaField = await page.$('#txtimgcode');
  
  if (captchaField) {
    console.log('⚠️  CAPTCHA detected! Switching to visible browser...');
    return 'captcha_required';
  }
  
  console.log('Clicking login button...');
  await takeScreenshot(page, 'before_login_click');
  
  await page.waitForSelector('#btnLogIn', { visible: true, timeout: 10000 });
  await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: settings.navigationTimeoutMs * 2 }),
      page.click('#btnLogIn'),
  ]);
  
  await delay(settings.pageLoadWaitMs * 2);
  
  await takeScreenshot(page, 'after_login_attempt');
  
  const currentUrl = page.url();
  const isStillLogin = await isLoginPage(page);
  
  console.log(`After login - URL: ${currentUrl}`);
  console.log(`Still on login page: ${isStillLogin}`);
  
  if (isStillLogin) {
    const errorMessages = await page.evaluate(() => {
      const errors = [];
      const errorSelectors = [
        '.error', '.alert', '.message', '[id*="error"]', '[id*="Error"]',
        '[class*="error"]', '[class*="Error"]', 'span[style*="color: red"]',
        'td[style*="color:red"]', '.validation-summary-errors'
      ];
      
      errorSelectors.forEach(selector => {
        const elements = document.querySelectorAll(selector);
        elements.forEach(el => {
          const text = el.textContent.trim();
          if (text) errors.push(text);
        });
      });
      
      return errors;
    });
    
    if (errorMessages.length > 0) {
      console.log('❌ Login failed with errors:', errorMessages);
      return 'login_failed';
    } else {
      console.log('❌ Login failed - still on login page but no error messages found. Current URL:', currentUrl);
      return 'login_failed';
    }
  }
  
  console.log('✅ Login appears successful!');
  
  const cookies = await page.cookies();
  fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookies, null, 2));
  console.log('Cookies saved for future sessions');
  
  return 'success';
}

/**
 * Checks if the current session is valid by trying to access a known post-login element
 * or URL that shouldn't redirect if logged in.
 */
async function checkSessionValidity(page) {
    try {
        console.log(`Attempting to navigate to dashboard (${settings.dashboardUrl}) to check session...`);
        // Navigate, and wait for network to be idle to ensure all resources are loaded
        await page.goto(settings.dashboardUrl, { waitUntil: 'networkidle2', timeout: 15000 });
        await delay(settings.pageLoadWaitMs * 2);

        const currentUrl = page.url();
        const isLogin = await isLoginPage(page);

        if (isLogin) {
            console.log('Session check: Redirected to login page. Session invalid.');
            return false;
        }

        const loggedInIndicators = await page.evaluate(() => {
            const logoutLink = document.querySelector('a[href*="Logout.aspx"]');
            const marksheetLink = document.querySelector('a[href*="Marksheet.aspx"]');
            const welcomeMessage = document.querySelector('[id*="Welcome"], [class*="welcome"]');
            const studentInfoArea = document.querySelector('#studentInfo, #profileArea, #userInfo');
            const mainContentArea = document.querySelector('#mainContent, .container');

            return (logoutLink !== null || marksheetLink !== null || welcomeMessage !== null || studentInfoArea !== null || mainContentArea !== null);
        });

        // --- ADDED DEBUGGING LOGS HERE ---
        const expectedDashboardUrlLower = settings.dashboardUrl.toLowerCase();
        const currentUrlLower = currentUrl.toLowerCase();
        const urlIncludesCheck = currentUrlLower.includes(expectedDashboardUrlLower);
        console.log(`DEBUG: Expected Dashboard URL (lower): ${expectedDashboardUrlLower}`);
        console.log(`DEBUG: Current URL (lower): ${currentUrlLower}`);
        console.log(`DEBUG: currentUrl.includes(expectedDashboardUrlLower): ${urlIncludesCheck}`);
        console.log(`DEBUG: loggedInIndicators: ${loggedInIndicators}`);
        // --- END DEBUGGING LOGS ---


        if (urlIncludesCheck && loggedInIndicators) { // Use the pre-calculated urlIncludesCheck
            console.log('Session check: Appears valid. On dashboard URL with logged-in indicators. Current URL:', currentUrl);
            return true;
        }
        
        console.log(`Session check: Failed. Current URL: ${currentUrl}, Is Login: ${isLogin}, Logged-in Indicators present: ${loggedInIndicators}`);
        await takeScreenshot(page, 'session_check_fail_after_navigation');
        return false;

    } catch (error) {
        console.log('Session check error (could be timeout or network issue):', error.message);
        await takeScreenshot(page, 'session_check_exception');
        return false;
    }
}


/**
 * Navigate to marksheet with session validation
 * Now also includes a robust check for marks-related content.
 */
async function navigateToMarksheet(page) {
  console.log('=== NAVIGATING TO MARKSHEET ===');
  
  console.log(`Navigating to: ${settings.marksheetUrl}`);
  
  try {
    await page.goto(settings.marksheetUrl, { 
      waitUntil: 'networkidle2',
      timeout: settings.navigationTimeoutMs * 2
    });
  } catch (error) {
    console.log(`Navigation error to marksheet URL (${settings.marksheetUrl}):`, error.message);
  }
  
  await delay(settings.pageLoadWaitMs * 5);
  
  await takeScreenshot(page, 'marksheet_page_initial_after_nav_delay');
  
  const isLogin = await isLoginPage(page);
  
  if (isLogin) {
    console.log('❌ Redirected to login page after marksheet navigation - session expired or invalid');
    return false;
  }

  // --- NEW: Robust check for marksheet content ---
  // **CRITICAL:** YOU MUST CUSTOMIZE THESE SELECTORS BASED ON THE ACTUAL ULK MIS PAGE.
  const hasMarksContent = await page.evaluate(() => {
    // Check for common grid view tables used for marks
    const gridViewMarks = document.querySelector('table[id*="GridviewMarks"], table[id*="gvMarks"], table[id*="MarksTable"], table[class*="marks-table"]');
    if (gridViewMarks) {
        console.log("PAGE_EVAL: Found marksheet grid view table.");
        return true;
    }

    // Check for headings that indicate academic results using standard selectors and text content check
    const marksPageHeadings = document.querySelectorAll('h1, h2, h3, h4, span[id*="lblPageTitle"]');
    for (const heading of Array.from(marksPageHeadings)) {
        const text = heading.textContent.trim();
        if (text.includes("Academic Results") || text.includes("My Grades") || text.includes("Marks") || text.includes("Academic Transcripts")) {
            console.log("PAGE_EVAL: Found marksheet heading:", text);
            return true;
        }
    }

    // Generic check for tables containing marks-related keywords
    const tables = document.querySelectorAll('table');
    const marksKeywords = ['course code', 'subject name', 'module title', 'ca mark', 'cat1', 'cat2', 'exam mark', 'total mark', 'grade point', 'grade', 'credits', 'status'];
    
    for (const table of Array.from(tables)) {
      const headerRow = table.querySelector('thead tr, tbody tr:first-child');
      if (headerRow) {
        const headerText = headerRow.textContent.toLowerCase();
        if (marksKeywords.some(keyword => headerText.includes(keyword))) {
          const rows = table.querySelectorAll('tr');
          if (rows.length >= 2) { // At least one header row and one data row
            console.log("PAGE_EVAL: Found table with marks-related keywords in headers and data rows.");
            return true;
          }
        }
      }
    }
    
    // Fallback: Check for key phrases in the body text
    const bodyText = document.body.innerText.toLowerCase();
    const hasRequiredKeywords = bodyText.includes('course code') && (bodyText.includes('total marks') || bodyText.includes('final grade') || bodyText.includes('credits acquired'));
    if (hasRequiredKeywords) {
        console.log("PAGE_EVAL: Found marks-related keywords in body text.");
        return true;
    }

    console.log("PAGE_EVAL: No marksheet content indicators found.");
    return false;
  });

  if (!hasMarksContent) {
    console.log('❌ Marksheet content (expected tables/headings/text) not found after navigation. Likely not on the correct page or data hasn\'t loaded.');
    await takeScreenshot(page, 'marksheet_content_missing_after_robust_check');
    return false;
  }
  
  console.log('✅ Successfully reached marksheet page and robust marks content check passed.');
  return true;
}

/**
 * Wait for marks data to load dynamically
 */
async function waitForMarksToLoad(page, maxWaitTime = 75000) {
  console.log('⏳ Waiting for marks data to load dynamically...');
  
  const startTime = Date.now();
  let previousTableCount = 0;
  let previousContentLength = 0;
  let stableCount = 0;
  const requiredStableChecks = 3;
  
  while (Date.now() - startTime < maxWaitTime) {
    try {
      const loadingData = await page.evaluate(() => {
        const loadingIndicators = [
          'loading', 'spinner', 'wait', 'processing', 'please wait',
          'loading...', 'fetching', 'retrieving', 'generating', 'calculating'
        ];
        
        const bodyText = document.body.innerText.toLowerCase();
        const hasLoadingText = loadingIndicators.some(indicator => 
          bodyText.includes(indicator)
        );
        
        const loadingElements = document.querySelectorAll([
          '.loading', '.spinner', '.loader', 
          '[class*="loading"]', '[id*="loading"]',
          '[class*="spinner"]', '[id*="spinner"]',
          '[style*="cursor:wait"]', '[aria-busy="true"]',
          '#updateProgress', '#ajaxLoader', '.blockUI'
        ].join(','));
        
        const visibleLoadingElements = Array.from(loadingElements).filter(el => {
          const style = window.getComputedStyle(el);
          return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
        });
        
        const tables = document.querySelectorAll('table');
        const marksKeywords = [
          'course', 'subject', 'module', 'code',
          'mark', 'marks', 'score', 'grade', 'point',
          'credit', 'cat1', 'cat2', 'exam', 'total'
        ];
        
        let marksTables = 0;
        let totalMarksRows = 0;
        
        tables.forEach(table => {
          const tableText = table.innerText.toLowerCase();
          const hasMarksKeywords = marksKeywords.some(keyword => 
            tableText.includes(keyword)
          );
          
          if (hasMarksKeywords) {
            marksTables++;
            const rows = table.querySelectorAll('tr');
            totalMarksRows += rows.length;
          }
        });
        
        return {
          hasLoadingText,
          visibleLoadingElementsCount: visibleLoadingElements.length,
          totalTables: tables.length,
          marksTables,
          totalMarksRows,
          contentLength: bodyText.length,
          hasContent: bodyText.length > 1000,
          sampleText: bodyText.substring(0, 300)
        };
      });
      
      console.log(`Loading check - Tables: ${loadingData.totalTables}, Marks Tables: ${loadingData.marksTables}, Visible Loading Elements: ${loadingData.visibleLoadingElementsCount}, Content: ${loadingData.contentLength} chars`);
      
      if (loadingData.hasLoadingText || loadingData.visibleLoadingElementsCount > 0) {
        console.log('📊 Still loading (loading indicators present)...');
        await delay(3000);
        continue;
      }
      
      if (loadingData.totalTables === previousTableCount && 
          loadingData.contentLength === previousContentLength &&
          loadingData.marksTables > 0) {
        stableCount++;
        console.log(`✓ Content stable check ${stableCount}/${requiredStableChecks}`);
        
        if (stableCount >= requiredStableChecks) {
          console.log('✅ Content has stabilized with marks data present');
          break;
        }
      } else {
        stableCount = 0;
        if (loadingData.marksTables > previousTableCount || 
            loadingData.contentLength > previousContentLength) {
          console.log('📈 Content is still growing or marks tables are appearing...');
        } else if (loadingData.totalTables === 0 && loadingData.contentLength < 500) {
          console.log('⚠️ Page seems empty or minimal, might be an issue.');
        }
      }
      
      previousTableCount = loadingData.totalTables;
      previousContentLength = loadingData.contentLength;
      
      await delay(2000);
      
    } catch (error) {
      console.log('Error during loading check:', error.message);
      await delay(2000);
    }
  }
  
  const waitTime = Date.now() - startTime;
  console.log(`⏱️  Waited ${Math.round(waitTime / 1000)}s for marks to load`);
  
  await takeScreenshot(page, 'after_marks_loading_wait');
  
  const finalCheck = await page.evaluate(() => {
    const tables = document.querySelectorAll('table');
    const marksKeywords = [
      'course', 'subject', 'module', 'code',
      'mark', 'marks', 'score', 'grade', 'point',
      'credit', 'cat1', 'cat2', 'exam', 'total'
    ];
    
    let marksTables = 0;
    tables.forEach(table => {
      const tableText = table.innerText.toLowerCase();
      const hasMarksKeywords = marksKeywords.some(keyword => 
        tableText.includes(keyword)
      );
      if (hasMarksKeywords) marksTables++;
    });
    
    return {
      totalTables: tables.length,
      marksTables,
      hasMarksData: marksTables > 0
    };
  });
  
  console.log(`Final check - Total tables: ${finalCheck.totalTables}, Marks tables: ${finalCheck.marksTables}`);
  
  return finalCheck.hasMarksData;
}

/**
 * Enhanced marks extraction with better error handling and comprehensive field mapping.
 */
async function extractMarksData(page) {
  console.log('=== EXTRACTING MARKS DATA ===');
  
  try {
    const marksData = await page.evaluate(() => {
      const results = {
        studentInfo: {},
        semesters: [],
        debug: {
          url: window.location.href,
          title: document.title,
          totalTables: document.querySelectorAll('table').length,
          pageText: document.body.innerText.substring(0, 1000)
        }
      };

      // --- Debugging logs inside page.evaluate() ---
      console.log('PAGE_EVAL: Page URL:', window.location.href);
      console.log('PAGE_EVAL: Page HTML body text (first 500 chars):', document.body.innerText.substring(0, 500));
      // --- End debugging logs ---
      
      // --- Student Information Extraction ---
      // **IMPORTANT: CUSTOMIZE THESE SELECTORS FOR YOUR ULK MIS STUDENT INFO**
      const studentInfoSelectors = [
          { key: 'name', selectors: ['#lblStudentName', '#studentName', '[id*="StudentNameField"]', 'td:contains("Student Name"):nth-of-type(1) + td', '.profile-info strong:first-child'] },
          { key: 'regNo', selectors: ['#lblRegNo', '#regNo', '[id*="RegNoField"]', 'td:contains("Registration No"):nth-of-type(1) + td', '.profile-info strong:nth-child(2)'] },
          { key: 'program', selectors: ['#lblProgram', '[id*="ProgramField"]', 'td:contains("Program"):nth-of-type(1) + td'] },
          { key: 'faculty', selectors: ['#lblFaculty', '[id*="FacultyField"]', 'td:contains("Faculty"):nth-of-type(1) + td'] }
      ];

      for (const info of studentInfoSelectors) {
          for (const selector of info.selectors) {
              try {
                  let element = document.querySelector(selector);
                  if (!element && selector.includes(':contains')) {
                      // Custom logic for :contains pseudo-selector
                      const potentialParents = document.querySelectorAll(selector.split(':contains')[0]);
                      for (const parent of Array.from(potentialParents)) {
                          if (parent.textContent.includes(selector.split('("')[1].split('")')[0])) {
                              element = parent.nextElementSibling || parent.querySelector('span') || parent.querySelector('div');
                              if(element) break; // Found element, break from inner loop
                          }
                      }
                  }
                  if (element && element.textContent.trim()) {
                      results.studentInfo[info.key] = element.textContent.trim();
                      console.log(`PAGE_EVAL: Student Info - ${info.key}: ${results.studentInfo[info.key]}`); // Debugging student info
                      break;
                  }
              } catch (e) {
                  // Ignore selector errors
              }
          }
      }

      // --- Marks Tables Extraction (MODIFIED SECTION) ---
      const tables = document.querySelectorAll('table');
      console.log(`PAGE_EVAL: Found ${tables.length} potential marks tables`);
      
      tables.forEach((table, index) => {
        const rows = table.querySelectorAll('tr');
        if (rows.length < 2) {
            console.log(`PAGE_EVAL: Table ${index} skipped - less than 2 rows.`);
            return;
        }
        
        let headerRow = table.querySelector('thead tr');
        if (!headerRow) {
            headerRow = rows[0];
        }

        const headers = Array.from(headerRow.querySelectorAll('th, td'))
          .map(cell => cell.textContent.trim().toLowerCase());
        
        const marksKeywords = [
          'course code', 'module code', 'subject code', 'course name', 'module name', 'subject name',
          'credit', 'credits', 'ch',
          'ca1', 'cat1', 'cont. assess. 1', 'continuous assessment 1',
          'ca2', 'cat2', 'cont. assess. 2', 'continuous assessment 2',
          'exam', 'examination', 'final exam',
          'total mark', 'overall mark', 'grand total', 'aggregate',
          'grade', 'letter grade',
          'grade point', 'gp', 'points',
          'remarks', 'comment', 'status'
        ];
        
        const isMarksTable = headers.some(header => 
          marksKeywords.some(keyword => header.includes(keyword))
        ) && (rows.length > 2);

        if (!isMarksTable) {
          console.log(`PAGE_EVAL: Table ${index} skipped - does not appear to be a marks table. Headers: [${headers.join(', ')}]`);
          return;
        }
        
        console.log(`PAGE_EVAL: Processing marks table ${index} - Headers: [${headers.join(', ')}]`);
        
        let semesterTitle = `Academic Period ${index + 1}`;
        let element = table.previousElementSibling;
        while (element) {
          if (element.tagName && ['H1','H2','H3','H4','H5','H6','DIV','SPAN','P'].includes(element.tagName.toUpperCase())) {
            const text = element.textContent.trim();
            if (text && text.length < 150 && (
                text.toLowerCase().includes('semester') || 
                text.toLowerCase().includes('academic year') ||
                text.toLowerCase().includes('year ') ||
                text.match(/^[a-z]+ \d{4}\/\d{4}$/i) // e.g., "Fall 2023/2024"
            )) {
              semesterTitle = text;
              console.log(`PAGE_EVAL: Found semester title for Table ${index}: "${semesterTitle}"`);
              break;
            }
          }
          element = element.previousElementSibling;
        }
        
        const semester = {
          title: semesterTitle,
          courses: []
        };
        
        const dataRows = Array.from(rows).slice(headerRow === rows[0] ? 1 : 0);
        
        dataRows.forEach(row => {
          const cells = Array.from(row.querySelectorAll('td, th'))
            .map(cell => cell.textContent.trim());
          
          if (cells.length < 2 || cells.every(c => !c)) {
            console.log('PAGE_EVAL: Skipping empty or malformed row:', cells);
            return;
          }
          
          const rowText = cells.join(' ').toLowerCase();
          if (rowText.includes('total') || rowText.includes('gpa') || rowText.includes('average') || 
              rowText.includes('passed') || rowText.includes('failed') || rowText.includes('overall') || 
              rowText.includes('cumulative') || rowText.includes('disclaimer')) {
            console.log('PAGE_EVAL: Skipping summary/footer row:', cells);
            return;
          }
          
          const course = {};

          // Helper to safely parse numeric values, or return null for invalid numbers
          // This parseNumberInPage is specifically for the page.evaluate context
          const parseNumberInPage = (value) => {
              if (typeof value === 'number') return value; // Already a number
              if (value === null || value === undefined || value.trim() === '') return null; // Handle empty/null strings
              const num = parseFloat(value.replace(/[^0-9.-]/g, '')); // Remove non-numeric chars except . and -
              return isNaN(num) ? null : num; // Return null if not a valid number
          };
          
          cells.forEach((cell, i) => {
            if (i >= headers.length || cell === null || cell === undefined) return; // Ensure cell is not null/undefined
            
            const header = headers[i];
            
            if (header.includes('code')) course.code = cell;
            else if (header.includes('course') || header.includes('subject') || header.includes('module') || header.includes('unit')) course.name = cell;
            // --- Apply parseNumberInPage to relevant fields ---
            else if (header.includes('credit') || header === 'ch') course.credits = parseNumberInPage(cell);
            else if (header.includes('ca1') || header.includes('cat1')) course.cat1 = parseNumberInPage(cell);
            else if (header.includes('ca2') || header.includes('cat2')) course.cat2 = parseNumberInPage(cell);
            else if (header.includes('exam') || header.includes('final')) course.exam = parseNumberInPage(cell);
            else if ((header.includes('total') || header.includes('overall') || header.includes('mark') || header.includes('score')) && !header.includes('remark')) course.totalMark = parseNumberInPage(cell);
            else if (header.includes('grade') && !header.includes('point')) course.grade = cell;
            else if (header.includes('point') || header === 'gp') course.gradePoint = parseNumberInPage(cell);
            // --- End parseNumberInPage application ---
            else {
                const cleanHeader = header.replace(/[^a-z0-9]/g, '');
                if (cleanHeader.length > 0 && !course[cleanHeader]) {
                    course[cleanHeader] = cell; // Catch-all for other columns
                }
            }
          });
          
          if (course.code || course.name) {
            semester.courses.push(course);
            console.log('PAGE_EVAL: Parsed course:', JSON.stringify(course)); // Debug each parsed course
          } else {
            console.log('PAGE_EVAL: Row did not yield a valid course (no code or name):', cells);
          }
        });
        
        if (semester.courses.length > 0) {
          results.semesters.push(semester);
          console.log(`PAGE_EVAL: Added semester "${semester.title}" with ${semester.courses.length} courses.`);
        } else {
            console.log(`PAGE_EVAL: Semester "${semester.title}" had no valid courses.`);
        }
      });
      
      return results;
    });
    
    return marksData;
  } catch (error) {
    console.error('Error in marks extraction (page.evaluate context):', error.message, error.stack);
    return { studentInfo: {}, semesters: [], debug: { error: error.message, stack: error.stack } };
  }
}

/**
 * Parses a string to an integer, returning a default if parsing fails.
 * This helper is for use outside page.evaluate.
 * @param {string|number|null} value - The value to parse.
 * @param {number} defaultValue - The value to return if parsing fails.
 * @returns {number} The parsed integer or the default value.
 */
function parseNumberForDB(value, defaultValue = 0) {
    if (typeof value === 'number') return Math.round(value); // If already a number, round it
    if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return defaultValue;
    const num = parseFloat(value);
    return isNaN(num) ? defaultValue : Math.round(num); // Round to integer as per Marksheet model
    // If your Marksheet model uses Float, use: return isNaN(num) ? defaultValue : num;
}

/**
 * Saves extracted marks data to the database using Prisma's Marksheet model.
 * This replaces the previous dataService.saveMarksData.
 *
 * @param {object} marksData - The extracted marks data object, typically containing
 * studentInfo and semesters with courses.
 * @returns {object} - Status and details of the save operation.
 */
async function saveMarksDataToPrisma(marksData) {
    console.log('💾 Prisma Save: Attempting to save marks data to Marksheet table...');

    if (!marksData || !marksData.studentInfo || !marksData.semesters) {
        console.warn('Prisma Save: No valid marksData received for saving. Missing studentInfo or semesters.');
        return { success: false, message: 'Invalid marks data provided.' };
    }

    const { studentInfo, semesters } = marksData;
    // Use the `regNo` from studentInfo as the student_uuid, with a fallback to 'abc123-uuid'
    const studentUuid = studentInfo.regNo && studentInfo.regNo !== 'N/A' ? studentInfo.regNo : 'abc123-uuid';

    if (!studentUuid) { // This check should ideally not be hit with the new fallback
        console.error('Prisma Save: Student registration number (student_uuid) is missing and fallback failed. Cannot save marks without a student identifier.');
        return { success: false, message: 'Student registration number is required to save marks.' };
    }
    console.log(`Prisma Save: Using student_uuid: ${studentUuid}`); // Log the actual student_uuid being used


    let recordsSavedCount = 0;
    let recordsSkippedCount = 0;
    let errorsCount = 0;

    try {
        for (const semesterData of semesters) {
            if (!Array.isArray(semesterData.courses) || semesterData.courses.length === 0) {
                console.warn(`Prisma Save: Skipping semester with no courses or invalid course data: ${semesterData.title}`);
                continue;
            }

            for (const courseData of semesterData.courses) {
                // Ensure we have at least a code or a name to save
                if (!courseData.code && !courseData.name) {
                    console.warn(`Prisma Save: Skipping course with no code or name in semester "${semesterData.title}": ${JSON.stringify(courseData)}`);
                    recordsSkippedCount++;
                    continue;
                }

                // Data sanitation and type conversion for the Marksheet model
                const dataToSave = {
                    student_uuid: studentUuid,
                    code: courseData.code || 'N/A', // Provide default if code is optional or missing
                    name: courseData.name || 'N/A', // Provide default if name is optional or missing
                    // Ensure numerical fields are converted using parseNumberForDB
                    credit: parseNumberForDB(courseData.credits),
                    cat1: parseNumberForDB(courseData.cat1),
                    cat2: parseNumberForDB(courseData.cat2),
                    exam_mark: parseNumberForDB(courseData.exam),
                    total_mark: parseNumberForDB(courseData.totalMark),
                };

                try {
                    // Decide between `create` and `upsert` based on your schema.prisma
                    // If you added `@@unique([student_uuid, code])` to Marksheet model, use upsert:
                    /*
                    const savedMark = await prisma.marksheet.upsert({
                        where: {
                            student_uuid_code: { // This is the default name for unique composite key
                                student_uuid: dataToSave.student_uuid,
                                code: dataToSave.code
                            }
                        },
                        update: dataToSave, // Data to update if record exists
                        create: dataToSave, // Data to create if record does not exist
                    });
                    */

                    // If not using upsert (or no unique constraint on student_uuid, code), use create:
                    // Note: If you use `create` without a unique constraint, re-running the scraper
                    // will create duplicate entries for the same student/course.
                    const savedMark = await prisma.marksheet.create({
                        data: dataToSave,
                    });

                    recordsSavedCount++;
                    console.log(`Prisma Save: Saved mark for ${dataToSave.code} (${dataToSave.name}) for student ${studentUuid}`);
                } catch (dbError) {
                    // Handle unique constraint violation (P2002) if you're using `create` but have
                    // somehow a unique constraint defined or want to treat duplicates specially
                    if (dbError.code === 'P2002') { // Prisma unique constraint violation error code
                        console.warn(`Prisma Save: Duplicate entry for course ${dataToSave.code} for student ${studentUuid}. Skipping. Error: ${dbError.message}`);
                        recordsSkippedCount++;
                    } else {
                        console.error(`Prisma Save: Error saving mark for ${dataToSave.code} for student ${studentUuid}:`, dbError.message);
                        errorsCount++;
                    }
                }
            }
        }

        console.log(`Prisma Save: Marks data save process completed.`);
        console.log(`Prisma Save: Total records saved: ${recordsSavedCount}`);
        console.log(`Prisma Save: Total records skipped (invalid/duplicate data): ${recordsSkippedCount}`);
        console.log(`Prisma Save: Total errors during save: ${errorsCount}`);

        if (errorsCount > 0) {
            return { success: false, message: `Completed with ${errorsCount} errors. Some marks might not have been saved.` };
        } else if (recordsSavedCount === 0 && recordsSkippedCount > 0) {
             return { success: true, message: `Completed, but no new valid marks were found to save. ${recordsSkippedCount} records skipped.` };
        } else if (recordsSavedCount === 0) {
             return { success: true, message: `Completed, but no marks data was found in the scraped content to save.` };
        }
        return { success: true, message: `Successfully saved ${recordsSavedCount} marks records.` };

    } catch (error) {
        console.error('❌ Prisma Save: Uncaught error during marks data saving process:', error);
        return { success: false, message: `An unhandled error occurred during saving: ${error.message}` };
    }
}


// --- Main Scraping Function ---
async function scrapeMarks() {
  console.log('🚀 Starting ULK marks scraper with enhanced session management and Prisma DB integration...');
  
  const userDataDir = path.join(settings.dataDir, 'puppeteer_user_data');
  ensureDirExists(userDataDir);
  console.log(`Using Puppeteer user data directory: ${userDataDir}`);

  let browser; 
  let page;    

  try {
    browser = await puppeteer.launch({ 
      headless: false, // Keep false for debugging, true for production
      defaultViewport: null, // Use page's default size
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        `--user-data-dir=${userDataDir}` // Persist user data for session cookies etc.
      ]
    });
    
    page = await browser.newPage(); 
    page.setDefaultTimeout(settings.navigationTimeoutMs * 3); // Increased default timeout for robustness
    
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // Enhanced console and response logging
    page.on('console', msg => {
      if (msg.type() === 'log' || msg.type() === 'warn' || msg.type() === 'error') {
        console.log(`🌐 PAGE JS (${msg.type().toUpperCase()}):`, msg.text());
      }
    });

    page.on('response', async response => {
      const request = response.request();
      const url = response.url();
      const status = response.status();
      const headers = response.headers();

      if (status >= 300 && status < 400 && headers.location) {
        console.log(`🚨 REDIRECT DETECTED: ${url} -> ${headers.location} (Status: ${status})`);
      } else if (status === 401 || status === 403) {
        console.log(`🔒 AUTH ISSUE DETECTED: ${url} (Status: ${status})`);
      }
    });

    // Load cookies if they exist
    if (fs.existsSync(COOKIES_PATH)) {
        try {
            const cookiesString = fs.readFileSync(COOKIES_PATH);
            const cookies = JSON.parse(cookiesString);
            await page.setCookie(...cookies);
            console.log('🍪 Loaded existing cookies.');
        } catch (error) {
            console.log('Failed to load cookies (corrupted file?), starting fresh session:', error.message);
            try { fs.unlinkSync(COOKIES_PATH); } catch (e) { console.log('Error deleting corrupted cookie file:', e.message); }
        }
    }
    
    console.log('\n🔄 Step 0: Checking initial session validity...');
    let sessionValid = await checkSessionValidity(page);

    if (sessionValid) {
        console.log('✅ Initial session appears valid, skipping login.');
    } else {
        console.log('❌ Initial session invalid or timed out, proceeding to login.');
        console.log('\n📝 Step 1: Login Process');
        const loginResult = await performLogin(page);
        
        if (loginResult === 'captcha_required') {
          console.log('⚠️  Manual intervention required for CAPTCHA');
          console.log('Please solve the CAPTCHA and click login in the browser window...');
          console.log(`Waiting ${settings.captchaSolveTimeMs / 1000} seconds for you to complete login...`);
          
          const startTime = Date.now();
          while (Date.now() - startTime < settings.captchaSolveTimeMs) {
            await delay(2000);
            const isLogin = await isLoginPage(page);
            if (!isLogin) {
              console.log('✅ Manual login completed successfully!');
              break;
            }
          }
          
          const finalCheck = await isLoginPage(page);
          if (finalCheck) {
            console.log('❌ Manual login not completed within time limit. Exiting.');
            return;
          }
          
          const cookies = await page.cookies();
          fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookies, null, 2));
          console.log('Cookies saved after manual login');
        } else if (loginResult === 'already_logged_in_or_redirected') {
            console.log('Scraper was redirected from login page, likely already logged in or login not required.');
            // Continue as if login was successful
        } else if (loginResult !== 'success') {
          console.log('❌ Login failed. Exiting.');
          return;
        }

        console.log('\n🔄 Post-Login: Re-checking session validity...');
        sessionValid = await checkSessionValidity(page);
        if (!sessionValid) {
            console.log('❌ Session still invalid after login attempt. This indicates a deeper issue with the login process or cookie handling. Exiting.');
            return;
        }
    }
    
    console.log('\n📊 Step 2: Navigate to Marksheet');
    const marksheetSuccess = await navigateToMarksheet(page);
    
    if (!marksheetSuccess) {
      console.log('❌ Failed to reach marksheet page with expected content. Exiting.');
      return;
    }
    
    console.log('\n🔍 Step 3: Handle Page Interactions');
    
    const dropdowns = await page.$$('select');
    console.log(`Found ${dropdowns.length} dropdown(s)`);
    
    for (let i = 0; i < dropdowns.length; i++) {
      const dropdown = dropdowns[i];
      const options = await dropdown.$$eval('option', opts => 
        opts.map(opt => ({ value: opt.value, text: opt.textContent.trim() }))
      );
      
      console.log(`Dropdown ${i} options:`, options.slice(0, 3)); // Log first 3 options for brevity
      
      const selectedValue = await dropdown.evaluate(el => el.value);
      if (!selectedValue && options.length > 1) {
        const firstOption = options.find(opt => opt.value && opt.value !== '');
        if (firstOption) {
          console.log(`Selecting: ${firstOption.text} (value: ${firstOption.value}) in dropdown ${i+1}`);
          await page.select(`select:nth-of-type(${i + 1})`, firstOption.value);
          await delay(settings.pageLoadWaitMs * 2);
          await takeScreenshot(page, `after_dropdown_${i}_selection`);
          if (await isLoginPage(page)) {
              console.log('❌ Redirected to login after dropdown selection. Session expired. Exiting.');
              return;
          }
        } else {
            console.log(`Dropdown ${i+1} has no selectable options with values.`);
        }
      } else {
          console.log(`Dropdown ${i+1} already has value selected: ${selectedValue}`);
      }
    }
    
    const buttons = await page.$$eval('input[type="submit"], button', btns =>
      btns.map(btn => ({
        id: btn.id,
        value: btn.value || btn.textContent,
        visible: btn.offsetParent !== null // Check if element is visible
      })).filter(btn => btn.visible && btn.value && !btn.value.toLowerCase().includes('cancel'))
    );
    
    console.log('Available buttons:', buttons);
    
    if (buttons.length > 0) {
      const viewButton = buttons.find(btn => 
        btn.value.toLowerCase().includes('view') ||
        btn.value.toLowerCase().includes('show') ||
        btn.value.toLowerCase().includes('display') ||
        btn.value.toLowerCase().includes('get') ||
        btn.value.toLowerCase().includes('submit') ||
        btn.value.toLowerCase().includes('generate')
      );

      const buttonToClick = viewButton || buttons[0]; // Prioritize 'view' button, else click the first available

      if (buttonToClick) {
        console.log(`Clicking button: "${buttonToClick.value}" (ID: ${buttonToClick.id || 'N/A'})`);
        
        try {
            await Promise.all([
                page.waitForNavigation({ waitUntil: 'networkidle2', timeout: settings.navigationTimeoutMs * 2 }),
                buttonToClick.id 
                    ? page.click(`#${buttonToClick.id}`) 
                    : page.evaluate(btnValue => {
                        const btn = Array.from(document.querySelectorAll('input[type="submit"], button')).find(
                            el => (el.value && el.value.toLowerCase().includes(btnValue.toLowerCase())) || 
                                  (el.textContent && el.textContent.toLowerCase().includes(btnValue.toLowerCase()))
                        );
                        if (btn) btn.click();
                        else throw new Error(`Button with value "${btnValue}" not found.`);
                    }, buttonToClick.value)
            ]);
        } catch (e) {
          console.log(`Button click or navigation timeout/error for "${buttonToClick.value}": ${e.message}. Checking if page changed successfully anyway.`);
          // If a navigation timeout occurs, it doesn't always mean failure.
          // The page might have loaded but waitForNavigation timed out because of lingering network requests.
        }
        
        await delay(settings.pageLoadWaitMs * 3); // Give extra time for AJAX content after button click
        await takeScreenshot(page, 'after_button_click');
        
        if (await isLoginPage(page)) {
          console.log('❌ Session expired or invalid after button click. Redirected to login. Exiting.');
          return;
        }
      } else {
        console.log('No suitable button to click found.');
      }
    } else {
        console.log('No interactive buttons found on the page.');
    }
    
    console.log('\n⏳ Step 4: Wait for Marks to Load');
    const marksLoaded = await waitForMarksToLoad(page, 90000); // Increased maxWaitTime
    
    if (!marksLoaded) {
      console.log('⚠️  No marks data detected after waiting. Proceeding with extraction anyway, but results might be incomplete.');
    }
    
    console.log('\n📚 Step 5: Extracting Marks Data');
    const marksData = await extractMarksData(page);
    
    // --- CRITICAL LOGGING ---
    console.log('--- RAW EXTRACTED MARKS DATA (Step 5) ---');
    console.log(JSON.stringify(marksData, null, 2));
    console.log('--- END RAW EXTRACTED MARKS DATA ---');
    // --- END CRITICAL LOGGING ---

    if (!marksData || !marksData.semesters || marksData.semesters.length === 0) {
      console.log('❌ No marks data extracted after all steps or semesters array is empty. Saving skipped. Exiting.');
      return;
    }
    
    console.log('\n💾 Step 6: Saving Data to Database using Prisma');
    console.log('Attempting to call saveMarksDataToPrisma...'); // Log before calling
    try {
        const saveResult = await saveMarksDataToPrisma(marksData);
        console.log('Database save result (Step 6):', saveResult);
    } catch (saveError) {
        console.error('❌ Error during saveMarksDataToPrisma (caught in main scraper):', saveError);
    }

  } catch (error) {
    console.error('🔥 CRITICAL SCRAPER ERROR (Top-Level Catch):', error);
    if (page) {
      await takeScreenshot(page, 'error_page');
    }
  } finally {
    if (browser) {
      await browser.close();
      console.log('Browser closed.');
    }
    // Disconnect Prisma Client when the application exits.
    await prisma.$disconnect();
    console.log('Prisma Client disconnected.');
    console.log('✅ Scraper finished.');
  }
}
scrapeMarks();
// Execute the scraper
// export default scrapeMarks;