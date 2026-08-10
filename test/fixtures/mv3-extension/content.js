/**
 * Content script for the MV3 harness fixture. Deliberately minimal: its only
 * job is to prove the extension actually loaded and injected, by stamping a
 * marker a page-context evaluate can read. Scoped to http://127.0.0.1/* so it
 * can never touch anything but the harness's own local pages.
 */
document.documentElement.dataset.cdpToolkitFixture = "content-injected";
