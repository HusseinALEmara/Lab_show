# Lab Show Application Vision

## 1. Application identity

Lab Show is a private desktop application for sharing screens and controlling computers inside a laboratory or local network. It is not a public website and must not require internet access for normal use.

The application uses Electron for the desktop interface and local-network communication. The server responsible for each live broadcast is the device that performs the broadcast, while the teacher computer is responsible for operating and controlling its own desktop.

## 2. Primary audience and language

The primary users are Arabic-speaking teachers and students.

Although this specification is written in English for development documentation, the application interface shown to users must be in Arabic. This includes:

- Titles and page headings
- Buttons and menus
- Input labels and placeholder text
- Status messages and notifications
- Error messages
- Control instructions
- Tray menu items
- Floating player controls
- Dialogs and confirmation prompts

Code identifiers and technical log messages may remain in English, but they must not be displayed directly to users.

## 3. Main roles

### 3.1 Teacher

A teacher can:

- Generate a unique broadcast code
- Enter a custom title or name for the broadcast
- Receive the screens of multiple students
- View each student in a separate card
- Switch between multiple student broadcasts
- Share the teacher's own screen
- Control the currently selected receiving computer only when permission is granted
- Keep the teacher application running in the background
- Open a small floating player outside the application
- Minimize or close the application using the Windows system tray

### 3.2 Student

A student can:

- Enter the code supplied by the teacher
- Enter a custom name or broadcast title
- Share the student's screen
- Enable or disable permission for the teacher to control the keyboard and allowed controls
- Show or hide the control switches that belong to the student's broadcast
- View the same broadcast title that appears on the teacher's cards
- Close or stop the broadcast independently

## 4. Broadcast discovery and connection

Users discover each other only within the same local network.

The teacher generates a short, unique code. A student joins by entering:

1. The teacher-generated code
2. A custom name or title for the student's broadcast

Example title:

`Ahmed Ali - Graduation Project`

The title entered by the student must be sent to the teacher and displayed with the student's broadcast card. The same title must remain visible on the student's broadcast device so that both sides refer to the same presenter.

The system must prevent or handle code collisions. The code identifies a teacher session and remains valid only for the configured duration.

## 5. Server and network responsibility

The application must operate in a laboratory/private LAN environment.

The server for a current live broadcast is the device that is broadcasting. This means the broadcaster owns the WebRTC or signaling data path for its session and remains the source of the displayed broadcast.

The teacher device acts as a receiver and controller. The teacher server is only responsible for managing teacher-side state and the teacher's own shared screen. It must not become the forced source for every participating student when the student is already broadcasting from another computer.

The architecture must:

- Discover peers through local-network UDP or an equivalent private LAN mechanism
- Establish direct or locally routed peer connections
- Keep signaling and media local to the laboratory network
- Avoid public exposure of broadcast streams
- Use the sender's network address and session code as a connection identity
- Recover safely when a broadcaster disconnects

## 6. Multiple simultaneous broadcasts

The teacher can receive more than one student broadcast at the same time.

Each connected student must have a unique identifier, for example:

`001`
`002`
`003`

Each student must be represented on the teacher side as a card similar to a YouTube-style video tile. A card must display:

- The student's custom broadcast title
- The unique student number
- Live or waiting status
- A preview of the shared screen
- Controls for selecting or stopping that broadcast

The teacher can select one card at a time. Only the selected student receives control commands.

The same title must be visible on both:

- The teacher's student card
- The student's sender or broadcast status page

## 7. Control activation and delivery

Control activation must be explicit and cannot be enabled silently.

The student must be able to enable or disable teacher control from the student's application or system-tray menu.

When control is enabled:

1. The teacher sends an approved control command to the receiving computer.
2. The application verifies that the command is against the currently selected student.
3. A copy of the control state or command is sent to the screen currently being viewed by the teacher.
4. The target student's device applies the command only if it is its selected control session.
5. The currently displayed teacher view updates the control state in real time.
6. The student can revoke permission immediately.

This means that each command is associated with the exact student/receiver identity currently selected on the teacher device. It must not be sent to every connected student.

When a teacher device receives control commands, it must operate the teacher device only. It must not automatically forward or duplicate those commands to a student unless the teacher intentionally selects a student broadcast and the student has granted control permission.

## 8. Bidirectional role support

A device is not permanently restricted to one role.

The same application can act as:

- A teacher generating and receiving broadcasts
- A student joining and sending a broadcast
- Both a teacher and a broadcaster when the user chooses both roles

Role switching must not stop an already active broadcast unless the user explicitly stops it.

## 9. Screen sharing rules

Screen capture must use Electron's desktop capture APIs.

The application must support:

- Starting, pausing, resuming, and stopping a broadcast
- Selecting the primary source screen
- Showing the broadcast status on the sender device
- Showing the live preview on the teacher device
- Keeping the sender responsible for the media stream
- A floating player while the main application is minimized

The shared application itself must not expose protected application windows or private desktop areas in a way that violates user expectations. The existing content-protection behavior must remain enabled for the main and floating control surfaces where applicable.

## 10. Floating player

The teacher can open a floating video player outside the main application. The floating player must:

- Remain visible above other windows
- Display the currently selected student's live video
- Show the custom broadcast title
- Allow switching back to the main application
- Provide a close or restore control
- Support ordinary minimize and close behavior

Closing the main window must not silently leave the application running as an invisible process. Closing or exiting from the system tray must completely stop the application and its local server.

## 11. System tray and background behavior

The application is allowed to run in the background only when the user explicitly minimizes or hides it. The tray menu must provide:

- Open the application
- Pause or resume the broadcast
- Enable or disable student control
- Stop the broadcast
- Exit the application

The tray menu must not present an accidental hidden process as a normal running state.

Closing the main window should offer or perform one clear behavior: close the application completely, or minimize it deliberately according to the same behavior consistently.

The Windows installer must close a running application using a dedicated update argument before replacing files. It must not appear as `application is already running` while the application is not visible or not accessible.

## 12. Security and local access

The system must enforce:

- Loopback-only host UI registration
- Local-subnet verification for external student addresses
- Explicit control permission
- A selected-student identity for every control command
- Session expiration
- Code removal when a session ends
- Duplicate-code checks
- No public internet streaming
- Safe cleanup of Socket.IO, HTTP, UDP, WebRTC, tray, and Electron resources

## 13. Lifecycle and installer behavior

All application resources must share one lifecycle:

- Electron window
- Express HTTP server
- Socket.IO server
- UDP discovery responder
- WebRTC peer connections
- System tray
- Floating player
- Native keyboard-control hooks

Starting, pausing, switching roles, closing the window, exiting the tray, uninstalling, and updating must clean up every related resource.

The installer must verify that no application process remains after closing and must launch the installed application successfully. The build must include all required JavaScript modules and native runtime dependencies.

## 14. User-visible status

The interface must make its state clear:

- Waiting for code
- Code generated
- Student connected
- Broadcasting
- Broadcast paused
- Control enabled
- Control disabled
- Session expired
- Network error
- Disconnected peer

Arabic text must be used for all of these states.

## 15. Development acceptance criteria

The implementation is complete when:

1. The application opens normally after installation.
2. Closing the application ends the process and tray icon.
3. The teacher can generate a code and custom broadcast title.
4. A student can join with a code and custom name.
5. The student title appears on the teacher card and on the student broadcast view.
6. The teacher can receive several students and switch cards.
7. Only the selected student receives an enabled control command.
8. Control permission can be revoked by the student.
9. Teacher commands do not affect unrelated students.
10. Broadcasting remains within the local network.
11. The floating player follows the selected title and student stream.
12. The system tray and lifecycle do not leave hidden processes behind.
13. Updating or reinstalling closes or replaces the application cleanly.
14. All visible UI text is Arabic.
