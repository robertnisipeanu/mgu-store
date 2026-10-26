# mgu-render changelog

## 0.2.0

- Its own socket, `/run/mgu-render/render.sock`. The community renderers' socket `/run/mgu-renderd/renderd.sock` is a link to it while no other renderer is installed (none of `shared_yield`'s unit files present): made by the socket unit at its start (`mgu-render --share`) and kept by the daemon every 2 s, removed when another renderer is installed, never replacing or removing anything that is not that link but a socket nobody listens on while no other renderer is installed (0.1's own, left when its socket unit restarts). Needs mgu-deploy 0.4.0. Upstream's and IterioDev's renderers take the path at their start; mgu-render takes it back once they are removed.
- Layer apps on ivi layer `0x4d520000 + slot` and surface `0x4d520100 + slot`, apart from the community renderers' `0x4d47…`.
- Touch divert in its own table `ip mgu_render`, ports 30570 in and 30571 out; on `lo` re-injections from IterioDev's renderer (30569) and ours (30571) go on to the HMI. The unit deletes only that table when it stops.
- The controller gate's event socket `@mgu-renderd-ccu` is bound only while an app grabs, and its file touched only while that socket is ours: upstream's renderer keeps the controller for its apps.
- An update leaves a running daemon running (`keepRunning`); the new version runs from its next start.
- `js/mgu_render_client.js` connects to the own socket, then to the community one when nothing listens there.
