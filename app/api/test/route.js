// import { Hono } from 'hono'
// import { handle } from 'hono/vercel'

// const app = new Hono().basePath('/api/tasks')

// let tasks = [{ id: 1, title: 'Learn Next' }]

// app.get('/', (c) => {
//   return c.json(tasks)
// })

// app.post('/', async (c) => {
//   const body = await c.req.json()
//   const title = typeof body?.title === 'string' ? body.title.trim() : ''

//   if (!title) {
//     return c.json({ error: 'Title is required' }, 400)
//   }

//   const newTask = {
//     id: Date.now(),
//     title,
//   }

//   tasks.push(newTask)
//   return c.json(newTask, 201)
// })

// export const GET = handle(app)
// export const POST = handle(app)