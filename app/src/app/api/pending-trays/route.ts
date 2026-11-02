import { NextResponse } from 'next/server';
import { listPendingTrays } from '@/lib/pending-trays';

/**
 * Trays that were just loaded with a spool SpoolmanSync could not identify and
 * are waiting for an answer (assign prompt). The spool page opened from an NFC
 * sticker or QR label offers these first.
 */
export async function GET() {
  try {
    return NextResponse.json({ pending: await listPendingTrays() });
  } catch (error) {
    console.error('Error listing pending trays:', error);
    return NextResponse.json({ error: 'Failed to list pending trays' }, { status: 500 });
  }
}
