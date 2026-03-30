module.exports = (sequelize, DataTypes) => {
  const Shift = sequelize.define(
    'Shift',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      org_id: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      name: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      start_time: {
        type: DataTypes.TIME,
        allowNull: false,
      },
      end_time: {
        type: DataTypes.TIME,
        allowNull: false,
      },
      crosses_midnight: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
      },
      work_days: {
        type: DataTypes.ARRAY(DataTypes.INTEGER),
        defaultValue: [1, 2, 3, 4, 5],
      },
      grace_minutes_checkin: {
        type: DataTypes.INTEGER,
        defaultValue: 15,
      },
      grace_minutes_checkout: {
        type: DataTypes.INTEGER,
        defaultValue: 60,
      },
      half_day_after_minutes: {
        type: DataTypes.INTEGER,
        defaultValue: 240,
      },
      absent_after_minutes: {
        type: DataTypes.INTEGER,
        defaultValue: 120,
      },
      overtime_after_minutes: {
        type: DataTypes.INTEGER,
        defaultValue: 480,
      },
      min_overtime_minutes: {
        type: DataTypes.INTEGER,
        defaultValue: 30,
      },
      break_minutes: {
        type: DataTypes.INTEGER,
        defaultValue: 60,
      },
      min_session_minutes: {
        type: DataTypes.INTEGER,
        defaultValue: 30,
      },
      session_cooldown_minutes: {
        type: DataTypes.INTEGER,
        defaultValue: 15,
      },
      max_sessions_per_day: {
        type: DataTypes.INTEGER,
        defaultValue: 3,
      },
    },
    {
      tableName: 'shifts',
      paranoid: true,
      underscored: true,
    }
  );

  Shift.associate = (models) => {
    Shift.belongsTo(models.Organisation, {
      foreignKey: 'org_id',
      as: 'organisation',
    });
    Shift.hasMany(models.Employee, {
      foreignKey: 'shift_id',
      as: 'employees',
    });
  };

  return Shift;
};
