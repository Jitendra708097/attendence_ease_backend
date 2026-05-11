module.exports = (sequelize, DataTypes) => {
  const AttendanceSession = sequelize.define(
    'AttendanceSession',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      attendance_id: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      org_id: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      emp_id: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      session_number: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      check_in_time: {
        type: DataTypes.DATE,
        allowNull: false,
      },
      check_out_time: DataTypes.DATE,
      check_in_lat: {
        type: DataTypes.DECIMAL(10, 8),
      },
      check_in_lng: {
        type: DataTypes.DECIMAL(11, 8),
      },
      check_out_lat: {
        type: DataTypes.DECIMAL(10, 8),
      },
      check_out_lng: {
        type: DataTypes.DECIMAL(11, 8),
      },
      selfie_url: {
        type: DataTypes.STRING,
      },
      worked_minutes: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
      },
      status: {
        type: DataTypes.ENUM('open', 'completed', 'auto_closed'),
        defaultValue: 'open',
      },
      is_undo_eligible: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
      },
    },
    {
      tableName: 'attendance_sessions',
      paranoid: true,
      underscored: true,
    }
  );

  AttendanceSession.associate = (models) => {
    AttendanceSession.belongsTo(models.Attendance, {
      foreignKey: 'attendance_id',
      as: 'attendance',
    });
  };

  return AttendanceSession;
};
