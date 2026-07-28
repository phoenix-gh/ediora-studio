// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from './alert-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from './dialog'

describe('DialogContent', () => {
  it.each(['sm', 'md', 'lg'] as const)(
    'opens %s dialogs, closes with Escape, and returns focus to its trigger',
    async size => {
      const user = userEvent.setup()
      const triggerLabel = `Open ${size}`

      render(
        <Dialog>
          <DialogTrigger>{triggerLabel}</DialogTrigger>
          <DialogContent size={size}>
            <DialogHeader>
              <DialogTitle>{size} dialog</DialogTitle>
              <DialogDescription>Dialog content</DialogDescription>
            </DialogHeader>
          </DialogContent>
        </Dialog>,
      )

      const trigger = screen.getByRole('button', { name: triggerLabel })
      await user.click(trigger)

      expect(await screen.findByRole('dialog')).toHaveAttribute('data-size', size)

      await user.keyboard('{Escape}')

      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      })
      expect(trigger).toHaveFocus()
    },
  )
})

describe('AlertDialogAction', () => {
  it('calls the destructive handler only after its explicit confirm button is activated', async () => {
    const user = userEvent.setup()
    const onDestructive = vi.fn()

    render(
      <AlertDialog>
        <AlertDialogTrigger>Remove post</AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this post?</AlertDialogTitle>
            <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={onDestructive}>
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>,
    )

    await user.click(screen.getByRole('button', { name: 'Remove post' }))
    expect(onDestructive).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onDestructive).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Remove post' }))
    await user.click(screen.getByRole('button', { name: 'Remove' }))

    expect(onDestructive).toHaveBeenCalledOnce()
  })
})
