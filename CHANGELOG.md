# Changelog

## 0.1.3

- Expose only the native purifier and linked air-quality services, removing
  redundant switch tiles.
- Make power, Auto/Manual mode, and Favorite level changes atomic over LAN.
- Apply optimistic HomeKit updates and ignore stale polls during commands.
- Debounce speed writes and guard against Apple Home's synthetic zero/old-value
  slider events during mode changes.
