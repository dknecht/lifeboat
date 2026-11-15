import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { ADMIN_TOKEN } from "./playwright.config";

const ADMIN = { authorization: `Bearer ${ADMIN_TOKEN}` };
const PASSWORD = "a very long password";

// Local data persists between runs, so every run uses names of its own.
const run = Date.now().toString(36);
const user = `dana-${run}@example.com`;
const alias = `support-${run}@example.com`;
const unknown = `nobody-${run}@example.com`;

interface Delivery {
  from: string;
  name: string;
  to: string;
  subject: string;
  contentType: "text/plain" | "text/html";
  body: string;
  messageId: string;
}

/** Hands a message to the Worker's inbound mail handler, as Email Routing would. */
async function deliver(request: APIRequestContext, mail: Delivery) {
  const raw = [
    `From: ${mail.name} <${mail.from}>`,
    `To: ${mail.to}`,
    `Subject: ${mail.subject}`,
    `Message-ID: ${mail.messageId}`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
    `Content-Type: ${mail.contentType}; charset=utf-8`,
    "",
    mail.body,
    "",
  ].join("\r\n");

  const response = await request.post(
    `/cdn-cgi/handler/email?from=${encodeURIComponent(mail.from)}&to=${encodeURIComponent(mail.to)}`,
    { data: raw, headers: { "content-type": "text/plain" } },
  );

  expect(response.status()).toBe(200);
}

/** Puts the service back in standby, whatever an earlier run left behind. */
async function ensureStandby(request: APIRequestContext) {
  await request.post("/api/admin/failover/deactivate", { headers: ADMIN, data: {} });
  await request.post("/api/admin/sync/run", { headers: ADMIN, data: {} });
}

async function signIn(page: Page) {
  await page.getByLabel("Work email address").fill(user);
  await page.getByLabel("Lifeboat password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

test.describe.configure({ mode: "serial" });

let page: Page;

test.beforeAll(async ({ browser, request }) => {
  await ensureStandby(request);
  page = await browser.newPage();
  // The app asks for confirmation before declaring or ending an outage.
  page.on("dialog", (dialog) => void dialog.accept());
});

test.afterAll(async ({ request }) => {
  await ensureStandby(request);
  await page.close();
});

test("a new user sets a password from an invite and signs in", async ({ request }) => {
  const created = await request.post("/api/admin/users", {
    headers: ADMIN,
    data: { email: user, displayName: "Dana Okafor", role: "admin", aliases: [alias] },
  });

  const inviteLink: string = (await created.json()).inviteLink;

  await page.goto(inviteLink.replace(/^https?:\/\/[^/]+/, ""));
  await page.getByLabel(/New password/).fill(PASSWORD);
  await page.getByLabel("Repeat the password").fill(PASSWORD);
  await page.getByRole("button", { name: "Set password" }).click();
  await page.getByRole("link", { name: "Go to sign in" }).click();

  await page.getByLabel("Work email address").fill(user);
  await page.getByLabel("Lifeboat password").fill("the wrong password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("The email address or password is incorrect.");

  await signIn(page);
  await expect(page.getByText("Calm seas")).toBeVisible();
  await expect(page).toHaveTitle("Inbox · Lifeboat");
});

test("an administrator declares an outage and mail starts arriving", async ({ request }) => {
  await page.getByRole("link", { name: "Admin" }).click();
  await page.getByLabel("Reason").fill("Exchange Online outage EX123456");
  await page.getByRole("button", { name: "Declare outage" }).click();
  await expect(page.getByRole("button", { name: "End outage and sync mail back" })).toBeVisible();
  await expect(page.getByText("Microsoft 365 email is unavailable.")).toBeVisible();

  await deliver(request, {
    from: "maria@contoso.test",
    name: "Maria Santos",
    to: user,
    subject: "Contract renewal due Friday",
    contentType: "text/html",
    body: '<p>Hi Dana, the renewal is due Friday.</p><script>parent.document.title="PWNED"</script><img src="http://tracker.test/p.gif">',
    messageId: `<renewal-${run}@contoso.test>`,
  });
  await deliver(request, {
    from: "ops@vendor.test",
    name: "Vendor Ops",
    to: alias,
    subject: "Ticket 4471 update",
    contentType: "text/plain",
    body: "Your ticket has been updated.",
    messageId: `<ticket-${run}@vendor.test>`,
  });
  await deliver(request, {
    from: "x@elsewhere.test",
    name: "Unknown",
    to: unknown,
    subject: "Misaddressed invoice",
    contentType: "text/plain",
    body: "Invoice attached",
    messageId: `<invoice-${run}@elsewhere.test>`,
  });

  await page.getByRole("link", { name: /Inbox/ }).click();
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByRole("link", { name: /Contract renewal due Friday/ })).toBeVisible();
  // Mail to the alias lands in the same inbox; mail to an unknown address does not.
  await expect(page.getByRole("link", { name: /Ticket 4471 update/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Misaddressed invoice/ })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /Inbox/ })).toContainText("2");
});

test("HTML mail is shown without running scripts or loading remote images", async () => {
  await page.getByRole("link", { name: /Contract renewal due Friday/ }).click();

  const body = page.frameLocator('iframe[title="Message body"]');

  await expect(body.getByText("Hi Dana, the renewal is due Friday.")).toBeVisible();
  await expect(page.getByText("Images hosted on other sites are hidden")).toBeVisible();
  await expect(page).toHaveTitle("Contract renewal due Friday · Lifeboat");
});

test("a reply is sent, confirmed, and joins the conversation", async () => {
  await page.getByRole("button", { name: "Reply" }).click();
  await expect(page.getByLabel("To", { exact: true })).toHaveValue("maria@contoso.test");
  await expect(page.getByLabel("Subject")).toHaveValue("Re: Contract renewal due Friday");
  await page.getByLabel("Message", { exact: true }).fill("Thanks Maria, we will sign by Thursday.");
  await page.getByRole("button", { name: "Send", exact: true }).click();

  await expect(page.getByText("Message sent")).toBeVisible();
  await expect(page).toHaveURL(/#\/sent$/);
  await expect(page.getByRole("link", { name: /Re: Contract renewal due Friday/ })).toBeVisible();

  // Opening the original now shows both messages as one conversation.
  await page.getByRole("link", { name: /Inbox/ }).click();
  await page.getByRole("link", { name: /Contract renewal due Friday/ }).click();
  await expect(page.getByText("2 messages in this conversation")).toBeVisible();
  await page.getByRole("button", { name: /You/ }).click();
  await expect(page.getByText("Thanks Maria, we will sign by Thursday.")).toBeVisible();
});

test("search finds a message by words in its body", async () => {
  await page.getByRole("link", { name: /Inbox/ }).click();
  await page.getByLabel("Search Inbox").fill("ticket has been updated");
  await expect(page.getByRole("link", { name: /Ticket 4471 update/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Contract renewal due Friday/ })).toHaveCount(0);

  await page.getByLabel("Search Inbox").fill("no such words anywhere");
  await expect(page.getByText("Nothing on the horizon")).toBeVisible();
  await page.getByLabel("Search Inbox").fill("");
});

test("a half-written message is kept as a draft and can be finished later", async () => {
  await page.getByRole("button", { name: "New message" }).click();
  await page.getByLabel("To", { exact: true }).fill("li.wei@partner.test");
  await page.getByLabel("Subject").fill("Agenda for Monday");
  await page.getByLabel("Message", { exact: true }).fill("First item: budget.");
  await expect(page.getByText("Draft saved")).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();

  await page.getByRole("link", { name: /Drafts/ }).click();
  await expect(page.getByRole("link", { name: /Drafts/ })).toContainText("1");
  await page.getByRole("button", { name: /Agenda for Monday/ }).first().click();
  await expect(page.getByLabel("To", { exact: true })).toHaveValue("li.wei@partner.test");
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("First item: budget.");

  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("Message sent").last()).toBeVisible();
  await page.getByRole("link", { name: /Drafts/ }).click();
  await expect(page.getByText("Nothing in the logbook")).toBeVisible();
});

test("held mail can be assigned to a user from the admin console", async () => {
  await page.getByRole("link", { name: "Admin" }).click();

  const row = page.getByRole("row", { name: new RegExp(unknown) });

  await expect(row).toContainText("Misaddressed invoice");
  await row.getByRole("textbox").fill(user);
  await row.getByRole("button", { name: "Assign" }).click();
  await expect(page.getByRole("row", { name: new RegExp(unknown) })).toHaveCount(0);

  await page.getByRole("link", { name: /Inbox/ }).click();
  await expect(page.getByRole("link", { name: /Misaddressed invoice/ })).toBeVisible();
});

test("on a phone the list and the reader show one at a time", async () => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.getByRole("link", { name: /Ticket 4471 update/ }).click();
  await expect(page.getByRole("link", { name: "Back" })).toBeVisible();
  await expect(page.getByLabel("Search Inbox")).toBeHidden();

  const overflows = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);

  expect(overflows).toBe(false);
  await page.getByRole("link", { name: "Back" }).click();
  await expect(page.getByLabel("Search Inbox")).toBeVisible();
  await page.setViewportSize({ width: 1360, height: 860 });
});

test("ending the outage returns the service to recovery", async () => {
  await page.getByRole("link", { name: "Admin" }).click();
  await page.getByRole("button", { name: "End outage and sync mail back" }).click();
  await expect(page.getByText("Recovering").first()).toBeVisible();
  await expect(page.getByText("Microsoft 365 is back.")).toBeVisible();
});

test("a passkey can be added and then used to sign in without a password", async () => {
  // Chromium can stand in for a fingerprint reader, so the real WebAuthn ceremony runs.
  const devtools = await page.context().newCDPSession(page);

  await devtools.send("WebAuthn.enable");
  await devtools.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });

  await page.getByRole("link", { name: "Account" }).click();
  await expect(page.getByText("You have no passkeys yet.")).toBeVisible();
  await page.getByLabel("Name for this device").fill("Work laptop");
  await page.getByRole("button", { name: "Add a passkey" }).click();
  await expect(page.getByText("Work laptop")).toBeVisible();
  await expect(page.getByText("not used yet")).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(page.getByRole("link", { name: /Inbox/ })).toBeVisible();

  await page.getByRole("link", { name: "Account" }).click();
  await expect(page.getByText(/last used/)).toBeVisible();
  await page.getByRole("button", { name: /Remove the passkey/ }).click();
  await expect(page.getByText("You have no passkeys yet.")).toBeVisible();
});
