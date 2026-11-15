export function createEventsOn(events) {
  return (name, callback) => events.On(name, event => callback(event.data));
}
