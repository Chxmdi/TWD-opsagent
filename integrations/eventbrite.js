import { getKV, setKV } from "../db.js";
import { updateEvent } from "../store.js";

export function isConfigured() {
  return Boolean(process.env.EVENTBRITE_TOKEN && process.env.EVENTBRITE_EVENT_ID);
}

export function status() {
  return { configured: isConfigured(), lastSync: getKV("eventbriteLastSync"), snapshot: getKV("eventbriteContext") || null };
}

export async function syncTickets() {
  if (!isConfigured()) throw new Error("Eventbrite is not configured. Set EVENTBRITE_TOKEN and EVENTBRITE_EVENT_ID.");
  const eventId = encodeURIComponent(process.env.EVENTBRITE_EVENT_ID);
  const headers = { authorization: `Bearer ${process.env.EVENTBRITE_TOKEN}` };
  const [eventResponse, ticketsResponse] = await Promise.all([
    fetch(`https://www.eventbriteapi.com/v3/events/${eventId}/`, { headers }),
    fetch(`https://www.eventbriteapi.com/v3/events/${eventId}/ticket_classes/`, { headers })
  ]);
  const [eventData, ticketsData] = await Promise.all([eventResponse.json(), ticketsResponse.json()]);
  if (!eventResponse.ok) throw new Error(eventData.error_description || "Eventbrite event request failed");
  if (!ticketsResponse.ok) throw new Error(ticketsData.error_description || "Eventbrite ticket request failed");
  const ticketClasses = (ticketsData.ticket_classes || []).map((ticket) => ({
    id: ticket.id,
    name: ticket.name,
    quantityTotal: ticket.quantity_total || 0,
    quantitySold: ticket.quantity_sold || 0,
    salesStart: ticket.sales_start || null,
    salesEnd: ticket.sales_end || null,
    free: Boolean(ticket.free),
    cost: ticket.cost?.display || null
  }));
  const sold = ticketClasses.reduce((sum, ticket) => sum + ticket.quantitySold, 0);
  const event = updateEvent({ ticketsSold: sold });
  const syncedAt = new Date().toISOString();
  const context = {
    syncedAt,
    event: {
      id: eventData.id,
      name: eventData.name?.text || eventData.name?.html || event.name,
      status: eventData.status || null,
      capacity: eventData.capacity || null,
      start: eventData.start?.utc || eventData.start?.local || null,
      end: eventData.end?.utc || eventData.end?.local || null,
      url: eventData.url || null,
      onlineEvent: Boolean(eventData.online_event)
    },
    ticketClasses,
    ticketsSold: sold,
    ticketGoal: event.ticketGoal
  };
  setKV("eventbriteLastSync", syncedAt);
  setKV("eventbriteContext", context);
  return context;
}
