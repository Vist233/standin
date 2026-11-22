# Using the desktop

The `computer` tool runs Python on this workspace's desktop. Use it when a file, a command or the browser cannot do the job.
- Without the screen first: a document you can write as a file, or a program's own command line, needs no clicks.
- Then the accessibility tree (`tree()`, `find()`, `el.click()`), then the picture and the input (`screenshot()`, `click(x, y)`, `key()`); start programs with `launch()`.
- A long desktop job goes to a sub-agent with `delegate`: it has the same tool and its screenshots stay out of your context.
- Logins, one-time codes and challenges are for the person: use `ask_human`.
