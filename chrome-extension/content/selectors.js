export const SELECTORS = Object.freeze({
  composeTrigger: [
    '[data-testid="SideNav_NewTweet_Button"]',
    'a[href="/compose/post"]',
    'a[href="/compose/tweet"]',
  ],
  composer: [
    '[data-testid="tweetTextarea_0"]',
  ],
  submit: [
    '[data-testid="tweetButton"]',
    '[data-testid="tweetButtonInline"]',
  ],
  schedulerTrigger: [
    '[data-testid="scheduleOption"]',
    '[data-testid="scheduledButton"]',
    '[aria-label="Schedule post"]',
    '[aria-label="Schedule"]',
    '[aria-label="安排帖子"]',
  ],
  schedulerDialog: [
    '[role="dialog"]',
  ],
  scheduleDate: [
    '[data-testid="scheduledDateField"]',
    '[data-testid="scheduleDateInput"]',
  ],
  scheduleTime: [
    '[data-testid="scheduledTimeField"]',
    '[data-testid="scheduleTimeInput"]',
  ],
  scheduleConfirm: [
    '[data-testid="scheduledConfirmationPrimaryAction"]',
    '[data-testid="scheduleConfirm"]',
  ],
  success: [
    '[role="alert"]',
    '[data-testid="toast"]',
  ],
})

export function findFirst(root, selectors) {
  if (!root || typeof root.querySelector !== 'function') return null
  for (const selector of selectors) {
    const element = root.querySelector(selector)
    if (element) return element
  }
  return null
}
